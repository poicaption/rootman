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
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// Admin-protected health check.
//   GET /api/health                     → basic env/redis ping
//   GET /api/health?code=ROOT-XXXX-XXXX → also dump that code's record
// Auth: Authorization: Bearer <ADMIN_SECRET>  (or ?token=... for browser convenience)
export default async function handler(req) {
  const url = new URL(req.url);
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) return json({ error: 'not_configured', message: 'ADMIN_SECRET not set' }, 500);

  const auth = req.headers.get('Authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const tokenParam = url.searchParams.get('token') || '';
  if (bearer !== adminSecret && tokenParam !== adminSecret) {
    return json({ error: 'unauthorized' }, 401);
  }

  const env = {
    hasRedisUrl: !!process.env.UPSTASH_REDIS_REST_URL,
    hasRedisToken: !!process.env.UPSTASH_REDIS_REST_TOKEN,
    hasStripeKey: !!process.env.STRIPE_SECRET_KEY,
    hasAdminSecret: !!process.env.ADMIN_SECRET,
    hasPassphraseV1: !!process.env.UNLOCK_PASSPHRASE,
    hasPassphraseV2: !!process.env.UNLOCK_PASSPHRASE_V2,
    passphraseV1Len: (process.env.UNLOCK_PASSPHRASE || '').length,
    passphraseV2Len: (process.env.UNLOCK_PASSPHRASE_V2 || '').length,
  };

  const out = { ok: true, ts: new Date().toISOString(), env, redis: null, code: null };

  try {
    const ping = await redis(['PING']);
    out.redis = { ok: true, response: ping };
  } catch (e) {
    out.redis = { ok: false, error: e.message };
    out.ok = false;
  }

  const codeParam = url.searchParams.get('code');
  if (codeParam) {
    try {
      const r = await redis(['GET', `code:${codeParam.toUpperCase()}`]);
      if (r && r.result) {
        const parsed = JSON.parse(r.result);
        out.code = {
          key: `code:${codeParam.toUpperCase()}`,
          found: true,
          vol: parsed.vol || 1,
          bound: !!parsed.device_id,
          device_id_prefix: parsed.device_id ? parsed.device_id.slice(0, 8) : null,
          session_id: parsed.session_id || null,
          created_at: parsed.created_at || null,
        };
      } else {
        out.code = { key: `code:${codeParam.toUpperCase()}`, found: false };
      }
    } catch (e) {
      out.code = { error: e.message };
    }
  }

  return json(out, out.ok ? 200 : 503);
}
