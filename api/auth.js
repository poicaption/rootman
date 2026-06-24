// Account auth endpoint — username/password accounts for The One Root Series.
// Self-registration. Email is NOT collected here; it is auto-filled later from
// the customer_email stored on a redeemed unlock code (see redeem-code.js).
// This system is ADDITIVE and does not touch the legacy device/unlock-code flow.
export const config = { runtime: 'edge' };

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SESSION_TTL = 60 * 60 * 24 * 90; // 90 days

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  return r.json();
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders },
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

function sessionCookie(token, maxAge) {
  return `or_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function safeParse(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return null; }
}

function randHex(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function pbkdf2(password, saltBytes, iters) {
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: iters, hash: 'SHA-256' },
    km,
    256
  );
  return new Uint8Array(bits);
}

function constEq(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function rateLimit(scope, key, max, windowSec) {
  const k = `rl:${scope}:${key}`;
  const r = await redis(['INCR', k]);
  const n = r && r.result;
  if (n === 1) await redis(['EXPIRE', k, windowSec]);
  return n <= max;
}

function normUser(u) {
  return String(u || '').trim().toLowerCase();
}

function validUsername(u) {
  return /^[a-z0-9_.]{3,20}$/.test(u);
}

async function buildEntitlements(uname) {
  const setRes = await redis(['SMEMBERS', `entitlements:${uname}`]);
  const vols = (setRes && setRes.result) || [];
  const out = [];
  for (const v of vols) {
    const metaRes = await redis(['GET', `entitlement:${uname}:${v}`]);
    const meta = safeParse(metaRes && metaRes.result) || {};
    out.push({ product: v, granted_at: meta.granted_at || null, via: meta.via || null, code: meta.code || null });
  }
  out.sort((a, b) => (a.product < b.product ? -1 : 1));
  return out;
}

async function createSession(uname, headers) {
  const token = randHex(32);
  await redis(['SET', `auth:session:${token}`, uname, 'EX', SESSION_TTL]);
  return sessionCookie(token, SESSION_TTL);
}

async function logUser(uname, event, extra = {}) {
  const entry = JSON.stringify({ event, at: new Date().toISOString(), ...extra });
  await redis(['LPUSH', `activity:user:${uname}`, entry]);
  await redis(['LTRIM', `activity:user:${uname}`, 0, 499]);
}

async function getSessionUser(req) {
  const tok = parseCookies(req)['or_session'];
  if (!tok) return null;
  const r = await redis(['GET', `auth:session:${tok}`]);
  return r && r.result ? String(r.result) : null;
}

async function me(req) {
  const uname = await getSessionUser(req);
  if (!uname) return json({ authenticated: false });
  const ur = await redis(['GET', `user:${uname}`]);
  const user = safeParse(ur && ur.result);
  if (!user) return json({ authenticated: false });
  const entitlements = await buildEntitlements(uname);
  return json({
    authenticated: true,
    username: user.username || uname,
    display_name: user.display_name || user.username || uname,
    email: user.email || null,
    status: user.status || 'active',
    entitlements,
  });
}

async function register(req, body) {
  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  if (!(await rateLimit('register', ip, 10, 3600))) {
    return json({ error: 'rate_limited', message: 'ลองใหม่อีกครั้งในภายหลัง' }, 429);
  }
  const uname = normUser(body.username);
  const password = String(body.password || '');
  let display = String(body.display_name || '').trim().slice(0, 60);
  if (!validUsername(uname)) {
    return json({ error: 'invalid_username', message: 'ชื่อผู้ใช้ต้องเป็น a-z, 0-9, _ . ความยาว 3-20 ตัว' }, 400);
  }
  if (password.length < 8 || password.length > 128) {
    return json({ error: 'invalid_password', message: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร' }, 400);
  }
  if (!display) display = uname;

  const exists = await redis(['GET', `user:${uname}`]);
  if (exists && exists.result) {
    return json({ error: 'username_taken', message: 'ชื่อผู้ใช้นี้ถูกใช้แล้ว' }, 409);
  }

  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const iters = 150000;
  const hash = await pbkdf2(password, salt, iters);
  const now = new Date().toISOString();
  const record = {
    username: uname,
    display_name: display,
    email: null,
    pass_salt: toB64(salt),
    pass_hash: toB64(hash),
    pass_iter: iters,
    status: 'active',
    created_at: now,
    last_login: now,
  };
  await redis(['SET', `user:${uname}`, JSON.stringify(record)]);
  await redis(['SADD', 'users:accounts', uname]);
  await redis(['LPUSH', 'accounts:recent', JSON.stringify({ username: uname, display_name: display, created_at: now })]);
  await redis(['LTRIM', 'accounts:recent', 0, 999]);
  await logUser(uname, 'register', { ip });

  const cookie = await createSession(uname, req.headers);
  return json(
    { ok: true, username: uname, display_name: display, email: null, entitlements: [] },
    200,
    { 'Set-Cookie': cookie }
  );
}

async function login(req, body) {
  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  const uname = normUser(body.username);
  const password = String(body.password || '');
  if (!uname || !password) {
    return json({ error: 'invalid_credentials', message: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' }, 400);
  }
  if (!(await rateLimit('login', `${ip}:${uname}`, 15, 900))) {
    return json({ error: 'rate_limited', message: 'พยายามเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่' }, 429);
  }
  const ur = await redis(['GET', `user:${uname}`]);
  const user = safeParse(ur && ur.result);
  if (!user) {
    return json({ error: 'invalid_credentials', message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' }, 401);
  }
  if (user.status === 'disabled') {
    return json({ error: 'account_disabled', message: 'บัญชีนี้ถูกระงับการใช้งาน' }, 403);
  }
  const salt = fromB64(user.pass_salt);
  const expected = fromB64(user.pass_hash);
  const got = await pbkdf2(password, salt, user.pass_iter || 150000);
  if (!constEq(got, expected)) {
    return json({ error: 'invalid_credentials', message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' }, 401);
  }
  user.last_login = new Date().toISOString();
  await redis(['SET', `user:${uname}`, JSON.stringify(user)]);
  await logUser(uname, 'login', { ip });
  const entitlements = await buildEntitlements(uname);
  const cookie = await createSession(uname, req.headers);
  return json(
    {
      ok: true,
      username: user.username || uname,
      display_name: user.display_name || uname,
      email: user.email || null,
      entitlements,
    },
    200,
    { 'Set-Cookie': cookie }
  );
}

async function logout(req) {
  const tok = parseCookies(req)['or_session'];
  if (tok) await redis(['DEL', `auth:session:${tok}`]);
  return json({ ok: true }, 200, { 'Set-Cookie': 'or_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' });
}

async function updateProfile(req, body) {
  const uname = await getSessionUser(req);
  if (!uname) return json({ error: 'not_authenticated', message: 'กรุณาเข้าสู่ระบบก่อน' }, 401);
  const ur = await redis(['GET', `user:${uname}`]);
  const user = safeParse(ur && ur.result);
  if (!user) return json({ error: 'not_authenticated' }, 401);

  const display = String(body.display_name || '').trim().slice(0, 60);
  if (!display) return json({ error: 'invalid_display_name', message: 'กรุณากรอกชื่อที่ใช้แสดง' }, 400);
  user.display_name = display;
  await redis(['SET', `user:${uname}`, JSON.stringify(user)]);
  await logUser(uname, 'update_profile', {});
  const entitlements = await buildEntitlements(uname);
  return json({ ok: true, username: user.username || uname, display_name: display, email: user.email || null, entitlements });
}

async function changePassword(req, body) {
  const uname = await getSessionUser(req);
  if (!uname) return json({ error: 'not_authenticated', message: 'กรุณาเข้าสู่ระบบก่อน' }, 401);
  const ur = await redis(['GET', `user:${uname}`]);
  const user = safeParse(ur && ur.result);
  if (!user) return json({ error: 'not_authenticated' }, 401);

  const current = String(body.current_password || '');
  const next = String(body.new_password || '');
  if (next.length < 8 || next.length > 128) {
    return json({ error: 'invalid_password', message: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร' }, 400);
  }
  const salt = fromB64(user.pass_salt);
  const expected = fromB64(user.pass_hash);
  const got = await pbkdf2(current, salt, user.pass_iter || 150000);
  if (!constEq(got, expected)) {
    return json({ error: 'wrong_password', message: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' }, 401);
  }
  const newSalt = new Uint8Array(16);
  crypto.getRandomValues(newSalt);
  const iters = 150000;
  const newHash = await pbkdf2(next, newSalt, iters);
  user.pass_salt = toB64(newSalt);
  user.pass_hash = toB64(newHash);
  user.pass_iter = iters;
  await redis(['SET', `user:${uname}`, JSON.stringify(user)]);
  await logUser(uname, 'change_password', {});
  return json({ ok: true });
}

export default async function handler(req) {
  if (!REDIS_URL || !REDIS_TOKEN) return json({ error: 'server_misconfigured' }, 500);
  const url = new URL(req.url);
  const qAction = url.searchParams.get('action') || '';

  if (req.method === 'GET') {
    if (qAction === '' || qAction === 'me') return me(req);
    return json({ error: 'unknown_action' }, 400);
  }
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let body = {};
  try { body = await req.json(); } catch (e) { body = {}; }
  const action = body.action || qAction;

  if (action === 'register') return register(req, body);
  if (action === 'login') return login(req, body);
  if (action === 'logout') return logout(req);
  if (action === 'update_profile') return updateProfile(req, body);
  if (action === 'change_password') return changePassword(req, body);
  return json({ error: 'unknown_action' }, 400);
}
