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
  // Bundle = all three volumes purchased in one Stripe session.
  const isBundle = volParam === 'bundle' || volParam === 'all' || url.searchParams.get('bundle') === '1';
  // Side Income Diagnostic Kit — a standalone PDF product (not part of the 1/2/3 reader series).
  const isSidk = volParam === 'sidk' || volParam === 'kit';
  const vol = volParam === '4' ? 4 : volParam === '3' ? 3 : volParam === '2' ? 2 : isSidk ? 'sidk' : 1;
  const vols = isBundle ? [1, 2, 3] : [vol];

  if (!sessionId || sessionId.length < 10) {
    return json({ error: 'missing_session', message: 'ไม่พบข้อมูลการชำระเงิน' }, 400);
  }

  try {
    // Idempotent: already generated for this session?
    const existing = await redis(['GET', `session:${sessionId}`]);
    if (existing.result) {
      const data = JSON.parse(existing.result);
      if (data.codes) {
        return json({ bundle: true, codes: data.codes, customer_email: data.customer_email || null });
      }
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

    const now = new Date().toISOString();

    // Extract payment evidence for fraud/chargeback defense (shared across all codes)
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

    const baseRecord = {
      session_id: sessionId,
      device_id: null,
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
      bundle: isBundle || undefined,
    };

    const emailKey = customerEmail ? `email:${customerEmail.trim().toLowerCase()}` : null;
    const activityKey = customerEmail ? `activity:${customerEmail.trim().toLowerCase()}` : null;

    const codes = []; // [{ vol, code }]

    // Mint one code per volume (1 for a single book, 3 for a bundle).
    for (const v of vols) {
      const code = generateCode();
      const codeRecord = { ...baseRecord, vol: v };

      // Code → data (permanent)
      await redis(['SET', `code:${code}`, JSON.stringify(codeRecord)]);

      // Per-volume purchase audit record (no TTL) — primary evidence ledger
      const purchaseKey = isBundle ? `purchase:${sessionId}:v${v}` : `purchase:${sessionId}`;
      await redis(['SET', purchaseKey, JSON.stringify({ ...codeRecord, code })]);

      // Email index for fast lookup during disputes
      if (emailKey) {
        await redis(['LPUSH', emailKey, JSON.stringify({ session_id: sessionId, code, vol: v, ts: now })]);
        await redis(['LTRIM', emailKey, 0, 49]);
      }

      // Payment-intent index (per code — Stripe disputes reference payment_intent)
      if (paymentIntent) {
        await redis(['SET', `pi:${paymentIntent}:v${v}`, JSON.stringify({ session_id: sessionId, code, vol: v, ts: now })]);
      }

      // Per-volume sales counter
      await redis(['INCR', `stats:purchases:vol${v}`]);

      codes.push({ vol: v, code });
    }

    // Buyer activity log (one entry summarising the transaction)
    if (activityKey) {
      await redis(['LPUSH', activityKey, JSON.stringify({
        type: 'purchase',
        bundle: isBundle || undefined,
        vols,
        codes: codes.map((c) => c.code),
        amount_total: amountTotal,
        currency,
        payment_intent: paymentIntent,
        customer_country: customerCountry,
        ip: buyerIp,
        ua: userAgent ? userAgent.slice(0, 200) : null,
      })]);
      await redis(['LTRIM', activityKey, 0, 499]);
    }

    // ── Global indexes for the admin dashboard ──
    // One recent-purchases entry per transaction.
    await redis(['LPUSH', 'purchases:recent', JSON.stringify({
      ts: now,
      email: customerEmail,
      name: customerName,
      country: customerCountry,
      code: codes.map((c) => c.code).join(', '),
      vol: isBundle ? 'bundle' : vols[0],
      bundle: isBundle || undefined,
      amount_total: amountTotal,
      currency,
      session_id: sessionId,
    })]);
    await redis(['LTRIM', 'purchases:recent', 0, 499]);

    if (customerEmail) {
      await redis(['SADD', 'users:emails', customerEmail.trim().toLowerCase()]);
    }
    // One transaction = one purchase event; revenue counted once at the full total.
    await redis(['INCR', 'stats:purchases:total']);
    if (isBundle) await redis(['INCR', 'stats:purchases:bundle']);
    if (amountTotal) {
      await redis(['INCRBY', `stats:revenue:${currency || 'unknown'}`, amountTotal]);
    }

    // Store session → code(s) (90-day TTL — used for thank-you page idempotency)
    if (isBundle) {
      await redis(['SET', `session:${sessionId}`, JSON.stringify({ codes, customer_email: customerEmail, bundle: true, created_at: now }), 'EX', 7776000]);
    } else {
      await redis(['SET', `session:${sessionId}`, JSON.stringify({ code: codes[0].code, customer_email: customerEmail, vol: vols[0], created_at: now }), 'EX', 7776000]);
    }

    console.log('[NEW-CODE]', JSON.stringify({ bundle: isBundle, codes: codes.map((c) => c.code), vols, session_id: sessionId.slice(0, 20) + '...', email: customerEmail, ts: now }));

    if (isBundle) {
      return json({ bundle: true, codes, customer_email: customerEmail });
    }
    return json({ code: codes[0].code, customer_email: customerEmail, vol: vols[0] });
  } catch (e) {
    console.error('[VERIFY-ERROR]', e.message);
    return json({ error: 'server_error', message: 'เกิดข้อผิดพลาด กรุณาลองรีเฟรชหน้านี้' }, 500);
  }
}
