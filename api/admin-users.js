// Admin-only: account (user) management for the back-office dashboard.
//
//   GET  /api/admin-users                  → list accounts (summary)
//   GET  /api/admin-users?username=foo      → account detail (entitlements,
//                                             claimed codes, activity log)
//   POST /api/admin-users                   → actions: disable | enable |
//                                             reset_password | unbind_code
//
// Auth: header `x-admin-token: <ADMIN_TOKEN>`  OR  `Authorization: Bearer ...`
//       (accepts ADMIN_TOKEN or ADMIN_SECRET). Header-only — never ?token=.
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
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function safeParse(s) {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
}

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

async function val(command, fallback = null) {
  try {
    const r = await redis(command);
    return r && r.result !== undefined ? r.result : fallback;
  } catch { return fallback; }
}

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
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

function publicUser(u) {
  if (!u) return null;
  return {
    username: u.username,
    display_name: u.display_name,
    email: u.email || null,
    status: u.status || 'active',
    created_at: u.created_at || null,
    last_login: u.last_login || null,
  };
}

async function listAccounts() {
  const names = (await val(['SMEMBERS', 'users:accounts'], [])) || [];
  const out = [];
  for (const name of names.slice(0, 1000)) {
    const u = safeParse(await val(['GET', `user:${name}`]));
    if (!u) continue;
    const ents = (await val(['SMEMBERS', `entitlements:${name}`], [])) || [];
    out.push({ ...publicUser(u), entitlement_count: ents.length, entitlements: ents.sort() });
  }
  out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return out;
}

async function accountDetail(name) {
  const u = safeParse(await val(['GET', `user:${name}`]));
  if (!u) return null;
  const entNames = (await val(['SMEMBERS', `entitlements:${name}`], [])) || [];
  const entitlements = [];
  for (const v of entNames.sort()) {
    const meta = safeParse(await val(['GET', `entitlement:${name}:${v}`])) || {};
    entitlements.push({ product: v, granted_at: meta.granted_at || null, via: meta.via || null, code: meta.code || null });
  }
  const codes = ((await val(['SMEMBERS', `user_codes:${name}`], [])) || []).sort();
  const actRaw = (await val(['LRANGE', `activity:user:${name}`, 0, 199], [])) || [];
  const activity = actRaw.map(safeParse).filter(Boolean);
  return { ...publicUser(u), entitlements, codes, activity };
}

async function doAction(body) {
  const action = body.action;
  const name = String(body.username || '').trim().toLowerCase();
  if (!name) return json({ error: 'username_required' }, 400);
  const u = safeParse(await val(['GET', `user:${name}`]));
  if (!u) return json({ error: 'user_not_found' }, 404);
  const now = new Date().toISOString();

  if (action === 'disable' || action === 'enable') {
    u.status = action === 'disable' ? 'disabled' : 'active';
    await redis(['SET', `user:${name}`, JSON.stringify(u)]);
    await redis(['LPUSH', `activity:user:${name}`, JSON.stringify({ event: `admin_${action}`, at: now })]);
    await redis(['LTRIM', `activity:user:${name}`, 0, 499]);
    return json({ ok: true, status: u.status });
  }

  if (action === 'reset_password') {
    const np = String(body.new_password || '');
    if (np.length < 8 || np.length > 128) return json({ error: 'invalid_password', message: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร' }, 400);
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    const iters = 150000;
    const hash = await pbkdf2(np, salt, iters);
    u.pass_salt = toB64(salt);
    u.pass_hash = toB64(hash);
    u.pass_iter = iters;
    await redis(['SET', `user:${name}`, JSON.stringify(u)]);
    await redis(['LPUSH', `activity:user:${name}`, JSON.stringify({ event: 'admin_reset_password', at: now })]);
    await redis(['LTRIM', `activity:user:${name}`, 0, 499]);
    return json({ ok: true });
  }

  if (action === 'unbind_code') {
    const code = String(body.code || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!code) return json({ error: 'code_required' }, 400);
    // Remove the binding so the code can be claimed by another account.
    await redis(['DEL', `claim:code:${code}`]);
    await redis(['SREM', `user_codes:${name}`, code]);
    // Clear annotation on the code record (preserve devices[] and all else).
    const rec = safeParse(await val(['GET', `code:${code}`]));
    let product = null;
    if (rec) {
      const n = parseInt(rec.vol, 10);
      product = n >= 1 && n <= 3 ? `vol${n}` : null;
      delete rec.claimed_by_user;
      delete rec.claimed_at;
      await redis(['SET', `code:${code}`, JSON.stringify(rec)]);
    }
    // Only remove the entitlement if no OTHER claimed code grants the same product.
    if (product) {
      const remaining = ((await val(['SMEMBERS', `user_codes:${name}`], [])) || []);
      let stillEntitled = false;
      for (const c of remaining) {
        const r2 = safeParse(await val(['GET', `code:${c}`]));
        const n2 = r2 && parseInt(r2.vol, 10);
        if (n2 && `vol${n2}` === product) { stillEntitled = true; break; }
      }
      if (!stillEntitled) {
        await redis(['SREM', `entitlements:${name}`, product]);
        await redis(['DEL', `entitlement:${name}:${product}`]);
      }
    }
    await redis(['LPUSH', `activity:user:${name}`, JSON.stringify({ event: 'admin_unbind_code', code, at: now })]);
    await redis(['LTRIM', `activity:user:${name}`, 0, 499]);
    return json({ ok: true, code, product });
  }

  return json({ error: 'unknown_action' }, 400);
}

export default async function handler(req) {
  const adminToken = process.env.ADMIN_TOKEN;
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminToken && !adminSecret) {
    return json({ error: 'not_configured', message: 'Neither ADMIN_TOKEN nor ADMIN_SECRET is set' }, 500);
  }
  const auth = req.headers.get('Authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const provided = req.headers.get('x-admin-token') || bearer;
  const allowed = [adminToken, adminSecret].filter(Boolean);
  if (!isAuthorized(provided, allowed)) return json({ error: 'unauthorized' }, 401);

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const username = (url.searchParams.get('username') || '').trim().toLowerCase();
      if (username) {
        const detail = await accountDetail(username);
        if (!detail) return json({ error: 'user_not_found' }, 404);
        return json(detail);
      }
      const accounts = await listAccounts();
      return json({ count: accounts.length, accounts });
    }
    if (req.method === 'POST') {
      let body = {};
      try { body = await req.json(); } catch { body = {}; }
      return await doAction(body);
    }
    return json({ error: 'method_not_allowed' }, 405);
  } catch (e) {
    return json({ error: 'server_error', message: String(e && e.message || e) }, 500);
  }
}
