// Redeem an unlock code into a logged-in account.
// RULE: one code can be bound to exactly ONE user, forever. Enforced atomically
// via `claim:code:{CODE}` (SET NX). This is ADDITIVE — it never touches the
// device[] array or the legacy /api/unlock flow. The customer email stored on
// the code (customer_email) is auto-filled into the account on first redeem.
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

async function logUser(uname, event, extra = {}) {
  const entry = JSON.stringify({ event, at: new Date().toISOString(), ...extra });
  await redis(['LPUSH', `activity:user:${uname}`, entry]);
  await redis(['LTRIM', `activity:user:${uname}`, 0, 499]);
}

function volId(rec) {
  const n = parseInt(rec && rec.vol, 10);
  return n >= 1 && n <= 3 ? `vol${n}` : 'vol1';
}

export default async function handler(req) {
  if (!REDIS_URL || !REDIS_TOKEN) return json({ error: 'server_misconfigured' }, 500);
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const uname = await getSessionUser(req);
  if (!uname) return json({ error: 'not_authenticated', message: 'กรุณาเข้าสู่ระบบก่อน' }, 401);

  let body = {};
  try { body = await req.json(); } catch (e) { body = {}; }
  const code = String(body.code || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!code) return json({ error: 'invalid_code', message: 'กรุณากรอก Unlock Code' }, 400);

  const cr = await redis(['GET', `code:${code}`]);
  const rec = safeParse(cr && cr.result);
  if (!rec) return json({ error: 'invalid_code', message: 'ไม่พบ Unlock Code นี้ในระบบ' }, 404);

  const product = volId(rec);

  // Atomic 1-code → 1-user binding.
  const setNx = await redis(['SET', `claim:code:${code}`, uname, 'NX']);
  const acquired = setNx && setNx.result === 'OK';

  if (!acquired) {
    const ownerRes = await redis(['GET', `claim:code:${code}`]);
    const owner = ownerRes && ownerRes.result ? String(ownerRes.result) : null;
    if (owner && owner !== uname) {
      return json({ error: 'code_taken', message: 'Unlock Code นี้ถูกผูกกับบัญชีอื่นแล้ว ไม่สามารถใช้ซ้ำได้' }, 409);
    }
    // Already owned by this user — make idempotent: ensure entitlement exists.
  }

  const now = new Date().toISOString();

  // Annotate the code record for admin visibility (preserve ALL existing fields,
  // including devices[] — we only add fields).
  if (!rec.claimed_by_user) {
    rec.claimed_by_user = uname;
    rec.claimed_at = now;
    await redis(['SET', `code:${code}`, JSON.stringify(rec)]);
  }

  // Grant entitlement.
  await redis(['SADD', `entitlements:${uname}`, product]);
  const existingMeta = await redis(['GET', `entitlement:${uname}:${product}`]);
  if (!(existingMeta && existingMeta.result)) {
    await redis(['SET', `entitlement:${uname}:${product}`, JSON.stringify({ granted_at: now, via: 'code', code })]);
  }
  await redis(['SADD', `user_codes:${uname}`, code]);

  // Auto-fill email from the code's customer_email (existing system) if not set.
  let email = null;
  const ur = await redis(['GET', `user:${uname}`]);
  const user = safeParse(ur && ur.result);
  if (user) {
    if (!user.email && rec.customer_email) {
      user.email = rec.customer_email;
      await redis(['SET', `user:${uname}`, JSON.stringify(user)]);
    }
    email = user.email || rec.customer_email || null;
  }

  await logUser(uname, 'redeem', { code, product });
  if (email) {
    await redis(['LPUSH', `activity:email:${email}`, JSON.stringify({ type: 'account_redeem', code, product, username: uname, at: now })]);
    await redis(['LTRIM', `activity:email:${email}`, 0, 499]);
  }

  return json({ ok: true, product, vol: parseInt(product.replace('vol', ''), 10), email });
}
