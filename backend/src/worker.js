const statuses = new Set(['healthy', 'degraded', 'down', 'inactive']);

function timestamp(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export async function collect(event, env, fetcher = fetch) {
  if (!/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? '') ||
      !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(env.TUNNEL_ID ?? '') ||
      !env.CLOUDFLARE_API_TOKEN) {
    throw new Error('Configure account ID, tunnel ID, and CLOUDFLARE_API_TOKEN');
  }
  const scheduledAt = new Date(event.scheduledTime).toISOString();
  let status = 'unknown', activeAt = null, inactiveAt = null, error = null;
  try {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${env.TUNNEL_ID}`,
      {
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
        signal: AbortSignal.timeout(15000)
      }
    );
    if (!response.ok) {
      error = `http_${response.status}`;
    } else {
      const body = await response.json();
      if (body.success !== true || body.result?.id !== env.TUNNEL_ID ||
          !statuses.has(body.result?.status)) {
        error = 'invalid_response';
      } else {
        status = body.result.status;
        activeAt = timestamp(body.result.conns_active_at);
        inactiveAt = timestamp(body.result.conns_inactive_at);
      }
    }
  } catch (cause) {
    error = cause?.name === 'TimeoutError' ? 'timeout' : 'request_failed';
  }
  const state = status === 'healthy' || status === 'degraded' ? 'up' : status;
  // One atomic upsert: triggers append history only on a change or monitoring gap.
  // Older/duplicate invocations cannot overwrite a newer check.
  await env.DB.prepare(`INSERT INTO tunnel_state
    (tunnel_id, scheduled_at, observed_at, status, raw_status, conns_active_at, conns_inactive_at, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tunnel_id) DO UPDATE SET
      scheduled_at=excluded.scheduled_at, observed_at=excluded.observed_at,
      status=excluded.status, raw_status=excluded.raw_status,
      conns_active_at=excluded.conns_active_at, conns_inactive_at=excluded.conns_inactive_at,
      error=excluded.error
    WHERE excluded.scheduled_at > tunnel_state.scheduled_at`)
    .bind(env.TUNNEL_ID, scheduledAt, new Date().toISOString(), state, status, activeAt, inactiveAt, error)
    .run();
  const log = error ? console.warn : console.info;
  log(JSON.stringify({ event: 'check_completed', scheduledAt, status: state,
    rawStatus: status, error, database: 'ok' }));
}

export async function dashboard(env, now = new Date()) {
  const since = new Date(now.getTime() - 7 * 86400000).toISOString();
  const localDay = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const firstChartDay = localDay(new Date(now.getTime() - 29 * 86400000));
  const tunnelId = env.TUNNEL_ID;
  const [current, previous, history, outages, totals, daily, firstCheck] = await Promise.all([
    env.DB.prepare('SELECT * FROM tunnel_state WHERE tunnel_id = ?').bind(tunnelId).first(),
    env.DB.prepare('SELECT * FROM transitions WHERE tunnel_id = ? AND scheduled_at < ? ORDER BY scheduled_at DESC LIMIT 1').bind(tunnelId, since).first(),
    env.DB.prepare('SELECT * FROM transitions WHERE tunnel_id = ? AND scheduled_at >= ? ORDER BY scheduled_at ASC').bind(tunnelId, since).all(),
    env.DB.prepare('SELECT * FROM outages WHERE tunnel_id = ? ORDER BY first_down_at DESC LIMIT 20').bind(tunnelId).all(),
    env.DB.prepare(`SELECT COUNT(*) AS outage_count,
      SUM(CASE WHEN outcome = 'recovered' THEN 1 ELSE 0 END) AS recovered_count,
      SUM(CASE WHEN outcome = 'recovered' THEN unixepoch(recovered_at) - unixepoch(first_down_at) ELSE 0 END) AS recovered_seconds,
      MAX(CASE WHEN outcome = 'recovered' THEN unixepoch(recovered_at) - unixepoch(first_down_at) END) AS longest_seconds
      FROM outages WHERE tunnel_id = ?`).bind(tunnelId).first(),
    env.DB.prepare(`SELECT date(first_down_at, '+6 hours') AS day,
      COUNT(*) AS outage_count,
      SUM(CASE WHEN outcome = 'recovered' THEN unixepoch(recovered_at) - unixepoch(first_down_at) ELSE 0 END) AS recovered_seconds
      FROM outages WHERE tunnel_id = ? AND date(first_down_at, '+6 hours') >= ?
      GROUP BY day ORDER BY day`).bind(tunnelId, firstChartDay).all(),
    env.DB.prepare('SELECT MIN(scheduled_at) AS first_at FROM transitions WHERE tunnel_id = ?').bind(tunnelId).first()
  ]);
  return { generated_at: now.toISOString(), since, current, transitions: [
    ...(previous ? [previous] : []), ...history.results
  ], outages: outages.results, first_check_at: firstCheck.first_at,
  totals, daily: daily.results };
}

export async function liveStatus(env, now = new Date()) {
  const current = await env.DB.prepare(
    'SELECT scheduled_at, raw_status, conns_active_at, conns_inactive_at FROM tunnel_state WHERE tunnel_id = ?'
  ).bind(env.TUNNEL_ID).first();
  const fresh = current && Number.isFinite(Date.parse(current.scheduled_at)) &&
    now.getTime() - Date.parse(current.scheduled_at) <= 180000;
  const result = fresh ? {
    status: current.raw_status,
    conns_active_at: current.conns_active_at,
    conns_inactive_at: current.conns_inactive_at
  } : { status: 'unknown', conns_active_at: null, conns_inactive_at: null };
  const isUp = result.status === 'healthy' && !result.conns_inactive_at;
  const status = result.status === 'unknown' ? 'unknown' : isUp ? 'up' : 'down';
  return {
    success: true,
    result,
    status,
    is_up: status === 'unknown' ? null : isUp,
    checked_at: current?.scheduled_at ?? null
  };
}

export default {
  async scheduled(event, env, ctx) {
    const scheduledAt = new Date(event.scheduledTime).toISOString();
    console.info(JSON.stringify({ event: 'check_started', scheduledAt }));
    try {
      await collect(event, env);
    } catch (error) {
      console.error(JSON.stringify({ event: 'check_failed', scheduledAt,
        message: error instanceof Error ? error.message : 'Unknown error' }));
      throw error;
    }
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/dashboard' && url.pathname !== '/api/live') {
      return new Response('Not found', { status: 404 });
    }
    const live = url.pathname === '/api/live';
    const cors = live ? {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'X-API-Key, Content-Type'
    } : {};
    if (live && request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { ...cors, Allow: 'GET' } });
    if (live && (!env.STATUS_REQUEST_KEY || request.headers.get('X-API-Key') !== env.STATUS_REQUEST_KEY)) {
      return Response.json({ success: false, error: 'Unauthorized' }, {
        status: 401, headers: { ...cors, 'Cache-Control': 'no-store' }
      });
    }
    try {
      return Response.json(live ? await liveStatus(env) : await dashboard(env), {
        headers: { ...cors, 'Cache-Control': 'no-store' }
      });
    } catch (error) {
      console.error('status query failed', error);
      return Response.json({ error: 'Database unavailable' }, { status: 503, headers: cors });
    }
  }
};
