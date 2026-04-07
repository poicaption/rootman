export const config = { runtime: 'edge' };

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
    const ip = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';

    // Hash the IP for privacy
    const ipBytes = new TextEncoder().encode(ip);
    const hashBuffer = await crypto.subtle.digest('SHA-256', ipBytes);
    const ipHash = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 16);

    const record = {
      ts: new Date().toISOString(),
      ip_hash: ipHash,
      screen: body.s || null,
      timezone: body.tz || null,
      language: body.l || null,
      platform: body.p || null,
      client_time: body.t || null,
    };

    // Log to Vercel's runtime logs (visible in Vercel Dashboard → Logs)
    console.log('[UNLOCK]', JSON.stringify(record));

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
