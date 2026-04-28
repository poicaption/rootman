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
const MASTER_HASH_V2 = '5726a7d599e3a196ec4863d400c8803023968ed11df253f139cb00cb657302e6';

function getPassphrase(vol) {
  if (vol === 2) {
    // Vol.2 master phrase. Falls back to env var if set, else hardcoded.
    return process.env.UNLOCK_PASSPHRASE_V2 || 'from known to real';
  }
  return process.env.UNLOCK_PASSPHRASE;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return json(null, 204);
  }
  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  let stage = 'init';
  try {
    stage = 'parse_body';
    const body = await req.json();
    const { code, device_id, action } = body;
    const reqVol = body.vol === 2 || body.vol === '2' ? 2 : 1;

    if (!code || !device_id) {
      return json({ error: 'missing_params', message: 'ข้อมูลไม่ครบ' }, 400);
    }

    // Master code → always works, no device restriction
    stage = 'master_hash';
    const hash = await sha256(code.trim().toLowerCase());
    if (hash === MASTER_HASH) {
      return json({ passphrase: getPassphrase(1), master: true, vol: 1 });
    }
    if (hash === MASTER_HASH_V2) {
      return json({ passphrase: getPassphrase(2), master: true, vol: 2 });
    }

    // Look up unique code in Redis
    stage = 'redis_get';
    const result = await redis(['GET', `code:${code.toUpperCase()}`]);
    if (result && result.error) {
      console.error('[UNLOCK-REDIS]', JSON.stringify({ code: code.toUpperCase(), redisError: result.error, reqVol }));
      return json({ error: 'redis_error', message: 'ระบบตรวจรหัสไม่พร้อม กรุณาลองใหม่' }, 503);
    }
    if (!result.result) {
      console.log('[UNLOCK-MISS]', JSON.stringify({ code: code.toUpperCase(), reqVol }));
      return json({ error: 'invalid_code', message: 'รหัสไม่ถูกต้อง' }, 400);
    }

    stage = 'parse_record';
    const data = JSON.parse(result.result);
    // Determine the volume this code unlocks. Codes saved before vol-tagging default to 1.
    const codeVol = data.vol === 2 ? 2 : 1;
    // If client requested a specific vol that mismatches the code's vol, reject.
    if (reqVol !== codeVol) {
      return json({ error: 'wrong_volume', message: 'รหัสนี้ใช้กับเล่มอื่น (Vol.' + codeVol + ')' }, 400);
    }
    const passphrase = getPassphrase(codeVol);

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
    const envFlags = {
      hasRedisUrl: !!process.env.UPSTASH_REDIS_REST_URL,
      hasRedisToken: !!process.env.UPSTASH_REDIS_REST_TOKEN,
      hasPassV1: !!process.env.UNLOCK_PASSPHRASE,
      hasPassV2: !!process.env.UNLOCK_PASSPHRASE_V2,
    };
    console.error('[UNLOCK-ERROR]', JSON.stringify({ stage, message: e && e.message, name: e && e.name, envFlags }));
    return json({
      error: 'server_error',
      message: 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง (' + stage + ')',
      stage,
    }, 500);
  }
}
