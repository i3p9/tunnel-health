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
  if (error) console.warn(JSON.stringify({ scheduledAt, error }));
}

export default {
  async scheduled(event, env) { await collect(event, env); },
  fetch() { return new Response('Not found', { status: 404 }); }
};
