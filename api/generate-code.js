// Admin-only: generate & manage unlock codes for each book (Vol.1 / 2 / 3).
//
//   POST /api/generate-code            → mint N new codes for a volume
//        body: { vol: 1|2|3, count: 1..50, note?: string }
//   GET  /api/generate-code            → list recently generated admin codes
//        ?limit=100  ?vol=1|2|3  ?status=unused|bound|redeemed|revoked
//
// Auth: header `x-admin-token: <ADMIN_TOKEN>`  OR  `Authorization: Bearer <ADMIN_SECRET|ADMIN_TOKEN>`
//       (shares creds with admin-overview / admin-users so the dashboard's
//        derived token works everywhere). Header-only — never ?token=.
//
// Generated codes use the SAME schema as Stripe-payment codes, so they unlock
// through the existing /api/unlock and /api/redeem-code paths unchanged. Each
// mint is also indexed under `admin:codes:generated` so the dashboard can list
// and track their live status (unused → bound to device → redeemed to account).

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

function generateCode() {
  // Crockford-ish alphabet — no 0/O/1/I/L to avoid read errors.
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const buf = new Uint32Array(8);
  crypto.getRandomValues(buf);
  let n = 0;
  const seg = (len) => {
    let s = '';
    for (let i = 0; i < len; i++) s += chars[buf[n++ % buf.length] % chars.length];
    return s;
  };
  return 'ROOT-' + seg(4) + '-' + seg(4);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-token',
    },
  });
}

function safeParse(s) {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
}

// Constant-time compare to avoid leaking the token via timing.
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

function normVol(v) {
  if (v === 'sidk' || v === 'kit') return 'sidk';
  return v === 4 || v === '4' ? 4 : v === 3 || v === '3' ? 3 : v === 2 || v === '2' ? 2 : 1;
}

// Derive a code's live status from its Redis record.
function codeStatus(rec) {
  if (!rec) return 'revoked';
  if (rec.claimed_by_user) return 'redeemed';
  const bound = !!rec.device_id || (Array.isArray(rec.devices) && rec.devices.length > 0);
  return bound ? 'bound' : 'unused';
}

function deviceCount(rec) {
  if (!rec) return 0;
  if (Array.isArray(rec.devices)) return rec.devices.length;
  return rec.device_id ? 1 : 0;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-token',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // ── Auth (shared with admin-overview / admin-users) ──
  const adminToken = process.env.ADMIN_TOKEN;
  const adminSecret = process.env.ADMIN_SECRET;
  const allowed = [adminToken, adminSecret].filter(Boolean);
  if (!allowed.length) {
    return json({ error: 'not_configured', message: 'Neither ADMIN_TOKEN nor ADMIN_SECRET is set' }, 500);
  }
  const auth = req.headers.get('Authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const provided = req.headers.get('x-admin-token') || bearer;
  if (!isAuthorized(provided, allowed)) {
    return json({ error: 'unauthorized' }, 401);
  }

  if (req.method === 'GET') return listCodes(req);
  if (req.method === 'POST') return generate(req);
  return json({ error: 'method_not_allowed' }, 405);
}

// ── List & track generated codes ──
async function listCodes(req) {
  const url = new URL(req.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit')) || 100, 1), 500);
  const volFilter = url.searchParams.get('vol');
  const statusFilter = url.searchParams.get('status');

  try {
    const raw = await redis(['LRANGE', 'admin:codes:generated', 0, limit - 1]);
    const entries = ((raw && raw.result) || []).map(safeParse).filter(Boolean);
    if (!entries.length) return json({ codes: [], count: 0, total_generated: 0, counts: { unused: 0, bound: 0, redeemed: 0, revoked: 0 } });

    // Batch-fetch every code record in one round-trip.
    const keys = entries.map((e) => `code:${e.code}`);
    const mget = await redis(['MGET', ...keys]);
    const recs = (mget && mget.result) || [];

    let codes = entries.map((e, i) => {
      const rec = safeParse(recs[i]);
      return {
        code: e.code,
        vol: normVol(e.vol),
        note: e.note || null,
        created_at: e.created_at || null,
        status: codeStatus(rec),
        claimed_by: (rec && rec.claimed_by_user) || null,
        device_count: deviceCount(rec),
      };
    });

    if (volFilter) codes = codes.filter((c) => String(c.vol) === String(normVol(volFilter)));
    if (statusFilter) codes = codes.filter((c) => c.status === statusFilter);

    const counts = { unused: 0, bound: 0, redeemed: 0, revoked: 0 };
    for (const c of codes) counts[c.status] = (counts[c.status] || 0) + 1;

    const totalRaw = await redis(['LLEN', 'admin:codes:generated']);
    const total = (totalRaw && totalRaw.result) || codes.length;

    return json({ codes, count: codes.length, counts, total_generated: total });
  } catch (e) {
    return json({ error: 'server_error', message: e.message }, 500);
  }
}

// ── Mint new codes ──
async function generate(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const note = (body.note ? String(body.note) : '').slice(0, 80).trim();
    const vol = normVol(body.vol);
    const count = Math.min(Math.max(parseInt(body.count) || 1, 1), 50); // max 50 per batch

    const codes = [];
    const now = new Date().toISOString();

    for (let i = 0; i < count; i++) {
      const code = generateCode();

      // Same schema as payment codes — device_id: null = not yet bound.
      await redis(['SET', `code:${code}`, JSON.stringify({
        session_id: `admin:${note || 'manual'}`,
        device_id: null,
        vol,
        created_at: now,
        source: 'admin',
      })]);

      // Index for the dashboard's code-management list.
      await redis(['LPUSH', 'admin:codes:generated', JSON.stringify({ code, vol, note: note || null, created_at: now })]);

      codes.push(code);
      console.log('[ADMIN-CODE]', JSON.stringify({ code, vol, note, ts: now }));
    }

    // Keep the index bounded.
    await redis(['LTRIM', 'admin:codes:generated', 0, 4999]);

    return json({ ok: true, codes, count: codes.length, vol, created_at: now, note: note || null });
  } catch (e) {
    console.error('[ADMIN-ERROR]', e.message);
    return json({ error: 'server_error', message: e.message }, 500);
  }
}
