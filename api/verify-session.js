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

    // Extract payment evidence for fraud/chargeback defense
    const customerDetails = session.customer_details || {};
    const customerEmail = customerDetails.email || null;
    const customerName = customerDetails.name || null;
    const customerCountry = (customerDetails.address && customerDetails.address.country) || null;
    const amountTotal = session.amount_total || null;
    const currency = session.currency || null;
    const paymentIntent = session.payment_intent || null;
    const paymentStatus = session.payment_status || null;
    const stripeCustomerId = session.customer || null;

    // Buyer fingerprint at thank-you page hit (legitimate fraud-prevention purpose)
    const buyerIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || null;
    const userAgent = req.headers.get('user-agent') || null;

    // Permanent code record — now includes proof-of-payment fields
    const codeRecord = {
      session_id: sessionId,
      device_id: null,
      vol,
      created_at: now,
      // Payment evidence
      customer_email: customerEmail,
      customer_name: customerName,
      customer_country: customerCountry,
      amount_total: amountTotal,
      currency,
      payment_intent: paymentIntent,
      payment_status: paymentStatus,
      stripe_customer_id: stripeCustomerId,
      buyer_ip: buyerIp,
      user_agent: userAgent,
    };

    // Store session → code (90-day TTL — used for thank-you page idempotency)
    await redis(['SET', `session:${sessionId}`, JSON.stringify({ code, customer_email: customerEmail, vol, created_at: now }), 'EX', 7776000]);

    // Store code → data (permanent)
    await redis(['SET', `code:${code}`, JSON.stringify(codeRecord)]);

    // Permanent purchase audit record (no TTL) — primary evidence ledger
    await redis(['SET', `purchase:${sessionId}`, JSON.stringify({ ...codeRecord, code })]);

    // Email index for fast lookup during disputes
    if (customerEmail) {
      const emailKey = `email:${customerEmail.trim().toLowerCase()}`;
      await redis(['LPUSH', emailKey, JSON.stringify({ session_id: sessionId, code, vol, ts: now })]);
      await redis(['LTRIM', emailKey, 0, 49]); // keep last 50 purchases per email

      // Seed the per-user activity timeline with the purchase event so each
      // customer's detailed usage ledger starts the moment they buy.
      const activityKey = `activity:email:${customerEmail.trim().toLowerCase()}`;
      await redis(['LPUSH', activityKey, JSON.stringify({
        ts: now,
        event: 'purchase',
        email: customerEmail,
        code,
        vol,
        amount_total: amountTotal,
        currency,
        payment_intent: paymentIntent,
        customer_country: customerCountry,
        ip: buyerIp,
        ua: userAgent ? userAgent.slice(0, 200) : null,
      })]);
      await redis(['LTRIM', activityKey, 0, 499]); // keep last 500 events per user
    }

    // Payment-intent index (Stripe uses payment_intent in dispute notifications)
    if (paymentIntent) {
      await redis(['SET', `pi:${paymentIntent}`, JSON.stringify({ session_id: sessionId, code, vol, ts: now })]);
    }

    // ── Global indexes for the admin dashboard ──
    // Recent-purchases feed (last 500) — powers the overview list.
    await redis(['LPUSH', 'purchases:recent', JSON.stringify({
      ts: now,
      email: customerEmail,
      name: customerName,
      country: customerCountry,
      code,
      vol,
      amount_total: amountTotal,
      currency,
      session_id: sessionId,
    })]);
    await redis(['LTRIM', 'purchases:recent', 0, 499]);

    // Distinct-customer set (for total unique buyers) + rolling revenue counters.
    if (customerEmail) {
      await redis(['SADD', 'users:emails', customerEmail.trim().toLowerCase()]);
    }
    await redis(['INCR', 'stats:purchases:total']);
    await redis(['INCR', `stats:purchases:vol${vol}`]);
    if (amountTotal) {
      await redis(['INCRBY', `stats:revenue:${currency || 'unknown'}`, amountTotal]);
    }

    // Log
    console.log('[NEW-CODE]', JSON.stringify({ code, vol, session_id: sessionId.slice(0, 20) + '...', email: customerEmail, ts: now }));

    return json({ code, customer_email: customerEmail, vol });
  } catch (e) {
    console.error('[VERIFY-ERROR]', e.message);
    return json({ error: 'server_error', message: 'เกิดข้อผิดพลาด กรุณาลองรีเฟรชหน้านี้' }, 500);
  }
}
