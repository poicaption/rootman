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
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const seg = (n) => {
    let s = '';
    for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  };
  return 'ROOT-' + seg(4) + '-' + seg(4);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } });
  }
  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  // Auth: Bearer token must match ADMIN_SECRET
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    return json({ error: 'not_configured', message: 'ADMIN_SECRET not set' }, 500);
  }

  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== adminSecret) {
    return json({ error: 'unauthorized' }, 401);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const note = body.note || '';
    const count = Math.min(Math.max(parseInt(body.count) || 1, 1), 20); // max 20 at once

    const codes = [];
    const now = new Date().toISOString();

    for (let i = 0; i < count; i++) {
      const code = generateCode();

      // Store with same schema as payment codes — device_id: null = not yet bound
      await redis(['SET', `code:${code}`, JSON.stringify({
        session_id: `admin:${note || 'manual'}`,
        device_id: null,
        created_at: now,
      })]);

      codes.push(code);
      console.log('[ADMIN-CODE]', JSON.stringify({ code, note, ts: now }));
    }

    return json({
      codes,
      count: codes.length,
      created_at: now,
      note: note || null,
    });
  } catch (e) {
    console.error('[ADMIN-ERROR]', e.message);
    return json({ error: 'server_error', message: e.message }, 500);
  }
}
