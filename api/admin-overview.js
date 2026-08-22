// Admin-only endpoint: aggregate overview for the back-office dashboard.
//
//   GET /api/admin-overview
//   GET /api/admin-overview?limit=100   (cap recent-purchases list, default 100, max 500)
//
// Auth: header `x-admin-token: <ADMIN_TOKEN>`  OR  `?token=<ADMIN_TOKEN>`
//       (also accepts ADMIN_SECRET so it shares creds with the other admin tools).
//
// Returns headline stats (total purchases, unique buyers, revenue per currency,
// volume split) plus the most recent purchases feed — everything the dashboard
// needs for its top cards and table without N extra round-trips.

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
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
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
  // Compare against every configured secret in constant time.
  let ok = false;
  for (const a of allowed) if (timingSafeEqual(provided, a)) ok = true;
  return ok;
}

async function val(command, fallback = null) {
  try {
    const r = await redis(command);
    return r && r.result !== undefined ? r.result : fallback;
  } catch {
    return fallback;
  }
}

export default async function handler(req) {
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

  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit')) || 100, 1), 500);

  try {
    // Recent purchases feed
    const recentRaw = await val(['LRANGE', 'purchases:recent', 0, limit - 1], []);
    const recent = Array.isArray(recentRaw) ? recentRaw.map(safeParse).filter(Boolean) : [];

    // Headline counters
    const totalPurchases = parseInt(await val(['GET', 'stats:purchases:total'], 0)) || 0;
    const vol1 = parseInt(await val(['GET', 'stats:purchases:vol1'], 0)) || 0;
    const vol2 = parseInt(await val(['GET', 'stats:purchases:vol2'], 0)) || 0;
    const vol3 = parseInt(await val(['GET', 'stats:purchases:vol3'], 0)) || 0;
    const vol4 = parseInt(await val(['GET', 'stats:purchases:vol4'], 0)) || 0;
    const vol5 = parseInt(await val(['GET', 'stats:purchases:vol5'], 0)) || 0;
    const uniqueBuyers = parseInt(await val(['SCARD', 'users:emails'], 0)) || 0;

    // Revenue per currency — discover currencies from the recent feed.
    const currencies = new Set();
    for (const p of recent) if (p.currency) currencies.add(p.currency);
    if (currencies.size === 0) currencies.add('thb');
    const revenue = {};
    for (const cur of currencies) {
      const minor = parseInt(await val(['GET', `stats:revenue:${cur}`], 0)) || 0;
      revenue[cur] = { amount_minor: minor, amount: minor / 100 };
    }

    // Today's purchases (from recent feed)
    const todayStr = new Date().toISOString().slice(0, 10);
    let purchasesToday = 0;
    for (const p of recent) {
      if (p.ts && String(p.ts).slice(0, 10) === todayStr) purchasesToday++;
    }

    return json({
      generated_at: new Date().toISOString(),
      stats: {
        total_purchases: totalPurchases,
        unique_buyers: uniqueBuyers,
        vol1_purchases: vol1,
        vol2_purchases: vol2,
        vol3_purchases: vol3,
        vol4_purchases: vol4,
        vol5_purchases: vol5,
        purchases_today: purchasesToday,
        revenue,
      },
      recent_purchases: recent,
    });
  } catch (e) {
    return json({ error: 'server_error', message: e.message }, 500);
  }
}
