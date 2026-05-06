// Admin-only endpoint to gather digital evidence for Stripe chargeback / fraud disputes.
// Accepts ONE of: ?session_id=cs_... | ?email=... | ?code=ROOT-... | ?payment_intent=pi_...
// Auth: header `x-admin-token: <ADMIN_TOKEN>` or query `?token=<ADMIN_TOKEN>`
//
// Returns: complete evidence package — payment record, generated code,
// every unlock/redemption event with timestamps + IP + user-agent + device fingerprint.
//
// Use the JSON output directly in your Stripe Dashboard → Disputes → "Submit evidence" form
// (paste in "Additional information" / upload as PDF). Recommended fields to highlight:
//   - customer_email matches Stripe's billing email
//   - amount_total + currency match the disputed charge
//   - generated_code timestamp = within seconds of payment
//   - usage_count > 0 proves the customer accessed the product
//   - distinct IPs / devices prove ongoing usage AFTER claimed "unauthorized charge" date

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

async function fetchStripeSession(sessionId) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey || !sessionId) return null;
  try {
    const res = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=payment_intent&expand[]=customer&expand[]=line_items`,
      { headers: { Authorization: `Basic ${btoa(stripeKey + ':')}` } }
    );
    if (!res.ok) return { error: `stripe_${res.status}` };
    return await res.json();
  } catch (e) {
    return { error: 'stripe_fetch_failed', message: e.message };
  }
}

async function buildEvidenceFromSession(sessionId) {
  const purchase = await getJson(`purchase:${sessionId}`);
  // Fallback to legacy session: key (older customers may not have purchase: index yet)
  const sessionLink = await getJson(`session:${sessionId}`);
  const code = (purchase && purchase.code) || (sessionLink && sessionLink.code) || null;

  let codeRecord = null;
  let auditEvents = [];
  let usageCount = 0;
  let distinctIps = [];
  let distinctDevices = [];
  let firstUseAt = null;
  let lastUseAt = null;

  if (code) {
    codeRecord = await getJson(`code:${code}`);
    const auditList = await redis(['LRANGE', `audit:code:${code}`, 0, -1]);
    if (Array.isArray(auditList && auditList.result)) {
      auditEvents = auditList.result.map(safeParse).filter(Boolean);
      usageCount = auditEvents.length;
      const ips = new Set();
      const devs = new Set();
      for (const ev of auditEvents) {
        if (ev.ip) ips.add(ev.ip);
        if (ev.device_id_short) devs.add(ev.device_id_short);
        if (!firstUseAt || ev.ts < firstUseAt) firstUseAt = ev.ts;
        if (!lastUseAt || ev.ts > lastUseAt) lastUseAt = ev.ts;
      }
      distinctIps = [...ips];
      distinctDevices = [...devs];
    }
  }

  // Live cross-check with Stripe (authoritative source of truth)
  const stripeSession = await fetchStripeSession(sessionId);

  return {
    queried_at: new Date().toISOString(),
    session_id: sessionId,
    code,
    purchase_record: purchase,
    code_record: codeRecord,
    stripe_session: stripeSession,
    usage_summary: {
      total_unlock_events: usageCount,
      distinct_ips: distinctIps.length,
      distinct_devices: distinctDevices.length,
      first_use_at: firstUseAt,
      last_use_at: lastUseAt,
      ip_list: distinctIps,
      device_list: distinctDevices,
    },
    audit_log: auditEvents,
  };
}

export default async function handler(req) {
  // Auth
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) return json({ error: 'admin_token_not_configured' }, 500);

  const url = new URL(req.url);
  const provided = req.headers.get('x-admin-token') || url.searchParams.get('token');
  if (!provided || provided !== adminToken) {
    return json({ error: 'unauthorized' }, 401);
  }

  const sessionId = url.searchParams.get('session_id');
  const email = url.searchParams.get('email');
  const code = url.searchParams.get('code');
  const paymentIntent = url.searchParams.get('payment_intent');

  try {
    // Resolve any of the lookup keys → session_id(s)
    let sessionIds = [];

    if (sessionId) {
      sessionIds = [sessionId];
    } else if (paymentIntent) {
      const piRec = await getJson(`pi:${paymentIntent}`);
      if (piRec && piRec.session_id) sessionIds = [piRec.session_id];
    } else if (code) {
      const codeRec = await getJson(`code:${code.toUpperCase()}`);
      if (codeRec && codeRec.session_id) sessionIds = [codeRec.session_id];
    } else if (email) {
      const list = await redis(['LRANGE', `email:${email.trim().toLowerCase()}`, 0, -1]);
      if (Array.isArray(list && list.result)) {
        sessionIds = list.result.map(safeParse).filter(Boolean).map(x => x.session_id).filter(Boolean);
      }
    } else {
      return json({ error: 'missing_query', hint: 'Provide one of: session_id, email, code, payment_intent' }, 400);
    }

    if (sessionIds.length === 0) {
      return json({ error: 'not_found', query: { sessionId, email, code, paymentIntent } }, 404);
    }

    const evidence = [];
    for (const sid of sessionIds) {
      evidence.push(await buildEvidenceFromSession(sid));
    }

    return json({
      generated_at: new Date().toISOString(),
      evidence_count: evidence.length,
      evidence,
    });
  } catch (e) {
    return json({ error: 'server_error', message: e.message }, 500);
  }
}
