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

// Append a content-access event to the per-code audit log AND, when we can
// resolve the buyer's email from the code, to that user's activity timeline.
// Best-effort only — must never break content rendering for the reader.
async function logAccess(code, event) {
  try {
    const codeUpper = code.toUpperCase();
    const auditKey = `audit:code:${codeUpper}`;
    await redis(['LPUSH', auditKey, JSON.stringify(event)]);
    await redis(['LTRIM', auditKey, 0, 199]);

    if (event.email) {
      const userKey = `activity:email:${String(event.email).trim().toLowerCase()}`;
      await redis(['LPUSH', userKey, JSON.stringify({ ...event, code: codeUpper })]);
      await redis(['LTRIM', userKey, 0, 499]);
    }
  } catch (_) { /* non-fatal */ }
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const ipRaw = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
    const ip = ipRaw.split(',')[0].trim() || 'unknown';

    // Hash the IP for the lightweight anonymous fingerprint log
    const ipBytes = new TextEncoder().encode(ip);
    const hashBuffer = await crypto.subtle.digest('SHA-256', ipBytes);
    const ipHash = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 16);

    const ts = new Date().toISOString();
    const record = {
      ts,
      ip_hash: ipHash,
      screen: body.s || null,
      timezone: body.tz || null,
      language: body.l || null,
      platform: body.p || null,
      client_time: body.t || null,
    };

    // Log to Vercel's runtime logs (visible in Vercel Dashboard → Logs)
    console.log('[UNLOCK]', JSON.stringify(record));

    // ── Attributed usage: when the reader's client sends its unlock code, we can
    // resolve the buyer's email and record that they actually opened & decrypted
    // the content (proof of usage, per-user reading activity). ──
    const code = body.code ? String(body.code).trim().toUpperCase() : null;
    if (code) {
      let email = null;
      let codeVol = null;
      try {
        const r = await redis(['GET', `code:${code}`]);
        if (r && r.result) {
          const data = JSON.parse(r.result);
          email = data.customer_email || null;
          codeVol = data.vol || 1;
        }
      } catch (_) { /* lookup failure is non-fatal */ }

      const reqVol = body.vol === 5 || body.vol === '5' ? 5
        : body.vol === 4 || body.vol === '4' ? 4
        : body.vol === 3 || body.vol === '3' ? 3
        : body.vol === 2 || body.vol === '2' ? 2 : (codeVol || 1);
      const ua = (req.headers.get('user-agent') || '').slice(0, 200) || null;

      await logAccess(code, {
        ts,
        event: 'content_access',
        email,
        vol: reqVol,
        device_id_short: body.did ? String(body.did).slice(0, 12) : null,
        ip,
        ua,
        screen: body.s || null,
        timezone: body.tz || null,
        platform: body.p || null,
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    console.error('[UNLOCK-ERROR]', e.message);
    return new Response(JSON.stringify({ ok: false }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}
