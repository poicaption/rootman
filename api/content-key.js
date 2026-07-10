// Content key endpoint — returns the decryption passphrase for a volume IF the
// logged-in account holds an entitlement for it. The reader's "Path 0" calls
// this; if it returns a passphrase the page decrypts via the existing engine.
// Entirely ADDITIVE — legacy device/code unlock continues to work untouched.
export const config = { runtime: 'edge' };

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  return r.json();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function parseCookies(req) {
  const h = req.headers.get('cookie') || '';
  const out = {};
  h.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function safeParse(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return null; }
}

async function getSessionUser(req) {
  const tok = parseCookies(req)['or_session'];
  if (!tok) return null;
  const r = await redis(['GET', `auth:session:${tok}`]);
  return r && r.result ? String(r.result) : null;
}

// Mirrors getPassphrase() in api/unlock.js.
function getPassphrase(vol) {
  if (vol === 2) return process.env.UNLOCK_PASSPHRASE_V2 || 'from known to real';
  if (vol === 3) return process.env.UNLOCK_PASSPHRASE_V3 || 'from store to system';
  if (vol === 4) return process.env.UNLOCK_PASSPHRASE_V4 || 'from unseen to unmissable';
  return process.env.UNLOCK_PASSPHRASE || '';
}

export default async function handler(req) {
  if (!REDIS_URL || !REDIS_TOKEN) return json({ error: 'server_misconfigured' }, 500);
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);

  const uname = await getSessionUser(req);
  if (!uname) return json({ error: 'not_authenticated' }, 401);

  const url = new URL(req.url);
  const vol = parseInt(url.searchParams.get('vol'), 10);
  if (!(vol >= 1 && vol <= 4)) return json({ error: 'invalid_vol' }, 400);
  const product = `vol${vol}`;

  const member = await redis(['SISMEMBER', `entitlements:${uname}`, product]);
  if (!(member && member.result === 1)) {
    return json({ error: 'no_entitlement', message: 'บัญชีนี้ยังไม่มีสิทธิ์อ่านเล่มนี้' }, 403);
  }

  const passphrase = getPassphrase(vol);
  if (!passphrase) return json({ error: 'server_misconfigured' }, 500);

  // Log content access (best-effort, non-blocking on errors).
  // Capture request fingerprint (IP / UA / geo) — this is the evidence that proves
  // the buyer actually opened & read the book, used to contest bank chargebacks.
  try {
    const now = new Date().toISOString();
    const ipRaw = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || '';
    const ip = ipRaw.split(',')[0].trim() || null;
    const ua = (req.headers.get('user-agent') || '').slice(0, 200) || null;
    const country = req.headers.get('x-vercel-ip-country') || null;
    let city = req.headers.get('x-vercel-ip-city') || null;
    if (city) { try { city = decodeURIComponent(city); } catch (e) { /* keep raw */ } }
    const fingerprint = { ip, ua, country, city };
    await redis(['LPUSH', `activity:user:${uname}`, JSON.stringify({ event: 'content_access', product, at: now, ...fingerprint })]);
    await redis(['LTRIM', `activity:user:${uname}`, 0, 499]);
    const ur = await redis(['GET', `user:${uname}`]);
    const user = safeParse(ur && ur.result);
    if (user && user.email) {
      await redis(['LPUSH', `activity:email:${user.email}`, JSON.stringify({ event: 'content_access', product, username: uname, ts: now, ...fingerprint })]);
      await redis(['LTRIM', `activity:email:${user.email}`, 0, 499]);
    }
  } catch (e) { /* ignore logging errors */ }

  return json({ passphrase, vol, product });
}
