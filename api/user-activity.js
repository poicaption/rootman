// Admin-only endpoint: detailed per-user (per-customer) usage report.
//
// Identifies a customer by the email they entered at Stripe checkout and returns
// their complete usage ledger — purchases, every unlock attempt, device binds /
// evictions, and content-access (reading) events — in one chronological timeline.
//
// Lookup (provide ONE):
//   GET /api/user-activity?email=buyer@example.com
//   GET /api/user-activity?code=ROOT-XXXX-XXXX        (resolves the owning email)
//   GET /api/user-activity?session_id=cs_...          (resolves the owning email)
//
// Auth: header `x-admin-token: <ADMIN_TOKEN>`  OR  `?token=<ADMIN_TOKEN>`
//       (falls back to ADMIN_SECRET so it shares creds with the other admin tools)
//
// Optional: &limit=200 to cap the number of timeline events returned (default 200).

export const config = { runtime: 'edge' };

async function redis(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis not configured');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  return res.json();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function safeParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

async function getJson(key) {
  const r = await redis(['GET', key]);
  return safeParse(r && r.result);
}

// Constant-time string comparison to avoid leaking the token via timing.
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isAuthorized(provided, allowed) {
  if (!provided) return false;
  let ok = false;
  for (const a of allowed) if (timingSafeEqual(provided, a)) ok = true;
  return ok;
}

async function lrangeJson(key) {
  const r = await redis(['LRANGE', key, 0, -1]);
  if (!r || !Array.isArray(r.result)) return [];
  return r.result.map(safeParse).filter(Boolean);
}

export default async function handler(req) {
  // Auth — accept either ADMIN_TOKEN (dispute-evidence convention) or ADMIN_SECRET.
  const adminToken = process.env.ADMIN_TOKEN;
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminToken && !adminSecret) {
    return json({ error: 'not_configured', message: 'Neither ADMIN_TOKEN nor ADMIN_SECRET is set' }, 500);
  }

  const url = new URL(req.url);
  const auth = req.headers.get('Authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  // Header-only: never accept ?token= (it can leak via access logs / browser history).
  const provided = req.headers.get('x-admin-token') || bearer;
  const allowed = [adminToken, adminSecret].filter(Boolean);
  if (!isAuthorized(provided, allowed)) {
    return json({ error: 'unauthorized' }, 401);
  }

  const emailParam = url.searchParams.get('email');
  const codeParam = url.searchParams.get('code');
  const sessionParam = url.searchParams.get('session_id');
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit')) || 200, 1), 500);

  try {
    // Resolve the customer email from whatever identifier was supplied.
    let email = emailParam ? emailParam.trim().toLowerCase() : null;

    if (!email && codeParam) {
      const codeRec = await getJson(`code:${codeParam.trim().toUpperCase()}`);
      if (codeRec && codeRec.customer_email) email = codeRec.customer_email.trim().toLowerCase();
    }
    if (!email && sessionParam) {
      const purchase = await getJson(`purchase:${sessionParam}`);
      const sessionLink = await getJson(`session:${sessionParam}`);
      const e = (purchase && purchase.customer_email) || (sessionLink && sessionLink.customer_email);
      if (e) email = e.trim().toLowerCase();
    }

    if (!email) {
      return json({ error: 'missing_query', hint: 'Provide one of: email, code, session_id (code/session must resolve to an email)' }, 400);
    }

    // ── Purchases owned by this email ──
    const purchases = await lrangeJson(`email:${email}`); // [{ session_id, code, vol, ts }]

    // Enrich each purchase with its permanent record + bound devices.
    const purchaseDetails = [];
    const codeSet = new Set();
    for (const p of purchases) {
      if (p.code) codeSet.add(String(p.code).toUpperCase());
      const codeRec = p.code ? await getJson(`code:${String(p.code).toUpperCase()}`) : null;
      const purchaseRec = p.session_id ? await getJson(`purchase:${p.session_id}`) : null;
      const devices = codeRec && Array.isArray(codeRec.devices)
        ? codeRec.devices
        : (codeRec && codeRec.device_id ? [codeRec.device_id] : []);
      purchaseDetails.push({
        code: p.code || null,
        vol: p.vol || (codeRec && codeRec.vol) || 1,
        purchased_at: p.ts || (purchaseRec && purchaseRec.created_at) || null,
        amount_total: purchaseRec && purchaseRec.amount_total,
        currency: purchaseRec && purchaseRec.currency,
        payment_intent: purchaseRec && purchaseRec.payment_intent,
        customer_name: purchaseRec && purchaseRec.customer_name,
        customer_country: purchaseRec && purchaseRec.customer_country,
        session_id: p.session_id || null,
        revoked: !codeRec, // code record gone = revoked/refunded
        active_devices: devices.map(d => (d ? String(d).slice(0, 12) : null)).filter(Boolean),
        device_count: devices.length,
      });
    }

    // ── Unified activity timeline (most recent first) ──
    let timeline = await lrangeJson(`activity:email:${email}`);
    // Sort newest → oldest defensively (LPUSH already gives this order).
    timeline.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
    const totalEvents = timeline.length;
    timeline = timeline.slice(0, limit);

    // ── Usage summary ──
    const ips = new Set();
    const devices = new Set();
    const eventCounts = {};
    let firstSeen = null;
    let lastSeen = null;
    for (const ev of timeline) {
      if (ev.ip) ips.add(ev.ip);
      if (ev.device_id_short) devices.add(ev.device_id_short);
      if (ev.event) eventCounts[ev.event] = (eventCounts[ev.event] || 0) + 1;
      if (ev.ts && (!firstSeen || ev.ts < firstSeen)) firstSeen = ev.ts;
      if (ev.ts && (!lastSeen || ev.ts > lastSeen)) lastSeen = ev.ts;
    }

    return json({
      generated_at: new Date().toISOString(),
      email,
      summary: {
        total_purchases: purchaseDetails.length,
        codes: [...codeSet],
        total_activity_events: totalEvents,
        events_returned: timeline.length,
        event_breakdown: eventCounts,
        distinct_ips: ips.size,
        distinct_devices: devices.size,
        ip_list: [...ips],
        device_list: [...devices],
        first_seen: firstSeen,
        last_seen: lastSeen,
      },
      purchases: purchaseDetails,
      activity_timeline: timeline,
    });
  } catch (e) {
    return json({ error: 'server_error', message: e.message }, 500);
  }
}
