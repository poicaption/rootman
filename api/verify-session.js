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
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
  }

  const url = new URL(req.url);
  const sessionId = url.searchParams.get('session_id');
  const volParam = url.searchParams.get('vol');
  const vol = volParam === '2' ? 2 : 1;

  if (!sessionId || sessionId.length < 10) {
    return json({ error: 'missing_session', message: 'ไม่พบข้อมูลการชำระเงิน' }, 400);
  }

  try {
    // Check if we already generated a code for this session (idempotent)
    const existing = await redis(['GET', `session:${sessionId}`]);
    if (existing.result) {
      const data = JSON.parse(existing.result);
      return json({ code: data.code, customer_email: data.customer_email || null, vol: data.vol || 1 });
    }

    // Verify with Stripe
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      return json({ error: 'config_error', message: 'ระบบชำระเงินยังไม่พร้อม กรุณาติดต่อผู้ดูแล' }, 500);
    }

    const stripeRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Basic ${btoa(stripeKey + ':')}` },
    });

    if (!stripeRes.ok) {
      return json({ error: 'invalid_session', message: 'ไม่พบข้อมูลการชำระเงิน' }, 400);
    }

    const session = await stripeRes.json();

    if (session.payment_status !== 'paid') {
      return json({ error: 'not_paid', message: 'การชำระเงินยังไม่สำเร็จ' }, 400);
    }

    // Generate unique code
    const code = generateCode();
    const now = new Date().toISOString();

    // Extract customer email for Advanced Matching
    const customerEmail = (session.customer_details && session.customer_details.email) || null;

    // Store session → code (90-day TTL)
    await redis(['SET', `session:${sessionId}`, JSON.stringify({ code, customer_email: customerEmail, vol, created_at: now }), 'EX', 7776000]);

    // Store code → data (permanent). Tag with vol so /api/unlock returns the right passphrase.
    await redis(['SET', `code:${code}`, JSON.stringify({ session_id: sessionId, device_id: null, vol, created_at: now })]);

    // Log
    console.log('[NEW-CODE]', JSON.stringify({ code, vol, session_id: sessionId.slice(0, 20) + '...', ts: now }));

    return json({ code, customer_email: customerEmail, vol });
  } catch (e) {
    console.error('[VERIFY-ERROR]', e.message);
    return json({ error: 'server_error', message: 'เกิดข้อผิดพลาด กรุณาลองรีเฟรชหน้านี้' }, 500);
  }
}
