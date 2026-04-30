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
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

// Admin endpoint to revoke a unique unlock code (e.g. after refund).
// Removes the code:{CODE} key in Redis so the customer's device can no longer
// auto-unlock and the code can no longer be entered. Also clears the matching
// session:{stripe_session_id} key (if present) so revisiting the thank-you
// page won't regenerate the same code.
//
//   POST /api/revoke-code
//   Authorization: Bearer <ADMIN_SECRET>
//   { "code": "ROOT-XXXX-XXXX" }
//
// Optional ?token= for browser convenience (matches /api/health).
export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) return json({ error: 'not_configured', message: 'ADMIN_SECRET not set' }, 500);

  const url = new URL(req.url);
  const auth = req.headers.get('Authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const tokenParam = url.searchParams.get('token') || '';
  if (bearer !== adminSecret && tokenParam !== adminSecret) {
    return json({ error: 'unauthorized' }, 401);
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const rawCode = (body && body.code ? String(body.code) : '').trim().toUpperCase();
  if (!rawCode) return json({ error: 'missing_code', message: 'Provide { "code": "ROOT-XXXX-XXXX" }' }, 400);

  const codeKey = `code:${rawCode}`;

  // Look up the record first so we can also clean the session: key and
  // return what was revoked for the audit trail.
  let record = null;
  try {
    const got = await redis(['GET', codeKey]);
    if (got && got.result) {
      try { record = JSON.parse(got.result); } catch { record = { raw: got.result }; }
    }
  } catch (e) {
    return json({ error: 'redis_error', message: e.message, stage: 'lookup' }, 503);
  }

  if (!record) {
    return json({ error: 'not_found', message: 'Code does not exist in Redis (already revoked?)', code: rawCode }, 404);
  }

  // Delete code:{CODE}
  let codeDel = null, sessionDel = null;
  try {
    const r1 = await redis(['DEL', codeKey]);
    codeDel = r1 && r1.result;
  } catch (e) {
    return json({ error: 'redis_error', message: e.message, stage: 'del_code' }, 503);
  }

  // Delete session:{session_id} if we have one
  if (record.session_id && !String(record.session_id).startsWith('admin:')) {
    try {
      const r2 = await redis(['DEL', `session:${record.session_id}`]);
      sessionDel = r2 && r2.result;
    } catch (e) {
      // Non-fatal — code is already revoked
      sessionDel = { error: e.message };
    }
  }

  console.log('[REVOKE-CODE]', JSON.stringify({
    code: rawCode,
    vol: record.vol || 1,
    was_bound: !!record.device_id,
    device_id_prefix: record.device_id ? String(record.device_id).slice(0, 8) : null,
    session_id: record.session_id || null,
    codeDel, sessionDel,
    ts: new Date().toISOString(),
  }));

  return json({
    ok: true,
    code: rawCode,
    revoked: {
      code_key: codeKey,
      code_del_count: codeDel,
      session_key: record.session_id ? `session:${record.session_id}` : null,
      session_del_count: sessionDel,
    },
    previous_record: {
      vol: record.vol || 1,
      was_bound: !!record.device_id,
      device_id_prefix: record.device_id ? String(record.device_id).slice(0, 8) : null,
      session_id: record.session_id || null,
      created_at: record.created_at || null,
    },
    note: 'Customer device will be locked again on next page reload. They cannot re-enter this code.',
  });
}
