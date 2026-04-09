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
  return new Response(data ? JSON.stringify(data) : null, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

async function sha256(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const MASTER_HASH = '2b9310c06c395990ca9438e5fab2177ca716237b877fdbda8b337b9047bb6b63';

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return json(null, 204);
  }
  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  try {
    const body = await req.json();
    const { code, device_id, action } = body;

    if (!code || !device_id) {
      return json({ error: 'missing_params', message: 'ข้อมูลไม่ครบ' }, 400);
    }

    // Master code → always works, no device restriction
    const hash = await sha256(code.trim().toLowerCase());
    if (hash === MASTER_HASH) {
      const passphrase = process.env.UNLOCK_PASSPHRASE;
      return json({ passphrase, master: true });
    }

    // Look up unique code in Redis
    const result = await redis(['GET', `code:${code.toUpperCase()}`]);
    if (!result.result) {
      return json({ error: 'invalid_code', message: 'รหัสไม่ถูกต้อง' }, 400);
    }

    const data = JSON.parse(result.result);
    const passphrase = process.env.UNLOCK_PASSPHRASE;

    // First use — bind device
    if (!data.device_id) {
      data.device_id = device_id;
      await redis(['SET', `code:${code.toUpperCase()}`, JSON.stringify(data)]);
      console.log('[UNLOCK-BIND]', JSON.stringify({ code: code.toUpperCase(), device_id: device_id.slice(0, 8) }));
      return json({ passphrase });
    }

    // Same device — OK
    if (data.device_id === device_id) {
      return json({ passphrase });
    }

    // Different device
    if (action === 'verify') {
      // Just checking — don't take over, report mismatch
      console.log('[DEVICE-MISMATCH]', JSON.stringify({ code: code.toUpperCase(), expected: data.device_id.slice(0, 8), got: device_id.slice(0, 8) }));
      return json({ error: 'device_mismatch', message: 'รหัสนี้ถูกใช้งานบนอุปกรณ์อื่นแล้ว กรุณาใส่ Unlock Code อีกครั้งเพื่อย้ายมาเครื่องนี้' }, 403);
    }

    // action === 'unlock' — take over device
    const oldDevice = data.device_id;
    data.device_id = device_id;
    await redis(['SET', `code:${code.toUpperCase()}`, JSON.stringify(data)]);
    console.log('[DEVICE-TAKEOVER]', JSON.stringify({ code: code.toUpperCase(), old: oldDevice.slice(0, 8), new: device_id.slice(0, 8) }));
    return json({ passphrase, device_changed: true });

  } catch (e) {
    console.error('[UNLOCK-ERROR]', e.message);
    return json({ error: 'server_error', message: 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง' }, 500);
  }
}
