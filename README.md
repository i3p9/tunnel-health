# Tunnel Health

Load-shedding tracker for a Dhaka homelab. A Cloudflare Worker polls the tunnel
API every minute and stores connectivity changes in D1.

`backend/` contains the Worker, migrations and tests. `frontend/` contains a
static dashboard served by the same Worker.

The dashboard shows current status, a 24-hour or 7-day state timeline, recent
outages, and 7-day or 30-day charts of outage count. Summary
statistics use the full retained transition history. Durations count only
recovered outages; an open or uncertain period has no reliable end time.
Tunnel downtime is a proxy for load shedding, not proof of its cause.

## Storage

- `tunnel_state`: one row per tunnel, updated each check. Includes freshness,
  raw Cloudflare status, connection timestamps and the latest error.
- `transitions`: initial state and subsequent changes. `healthy`/`degraded` map
  to `up`; `down`, `inactive` and `unknown` remain distinct.
- `outages`: view of down periods, marked `recovered`, `open` or `uncertain`.

Failed checks become `unknown`. Missed minutes insert an unknown boundary on the
next check. Check `tunnel_state.scheduled_at` before treating an open outage as
ongoing. Duplicate/stale invocations are ignored; updates and history inserts
are atomic. Migration 0002 imports existing observations into the new tables;
migration 0003 drops the old `observations` table.

Timestamps are UTC; use `Asia/Dhaka` for charts. Boundaries reflect detection,
not exact power-loss times. Short outages can be missed. History grows only on
changes or monitoring gaps; the current-state row still gets 1,440 updates/day.

## Setup

Node 24+, pnpm. Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --dir backend exec wrangler login
pnpm --dir backend exec wrangler d1 create tunnel-health
```

Set account, tunnel and database IDs in `backend/wrangler.jsonc`. Create an
account-scoped API token with **Cloudflare Tunnel: Read**, then:

```sh
pnpm --dir backend exec wrangler secret put CLOUDFLARE_API_TOKEN
pnpm db:remote
pnpm run deploy
```

Cron: `* * * * *`. The Worker also serves the dashboard and its read-only
`/api/dashboard` endpoint. `/api/live` is a small public JSON endpoint for a
status page. Set its request key with
`pnpm --dir backend exec wrangler secret put STATUS_REQUEST_KEY` using the same
UUID that the status page sends in `X-API-Key`. It returns `status` (`up`, `down`, or `unknown`),
`is_up` (`true`, `false`, or `null`), and `checked_at` in UTC. It also returns a
Cloudflare-like `result` with `status`, `conns_active_at`, and
`conns_inactive_at` so the existing homelab status page can read it. For that
page, only `healthy` without `conns_inactive_at` counts as up. A check older than
three minutes reports `unknown`, even if its last stored state was `up`.
The live endpoint allows cross-origin GET requests with that header and exposes
no account ID or Cloudflare API token. Configure a route or domain before deployment;
`workers_dev` is disabled. Protect the route with Cloudflare Access if the
dashboard should be private. Allow up to 15 minutes for cron configuration to
propagate.

## Development

```sh
pnpm test
pnpm check
pnpm db:local
cp backend/.dev.vars.example backend/.dev.vars
# Add the API token to backend/.dev.vars (gitignored).
pnpm dev
curl 'http://localhost:8787/__scheduled?cron=*+*+*+*+*'
```

Local runs query the real API and write local D1. Tests use mocked HTTP and
SQLite. CI runs tests and a bundle check.

## Inspect

```sh
pnpm --dir backend exec wrangler d1 execute tunnel-health --remote --command "SELECT * FROM tunnel_state"
pnpm --dir backend exec wrangler d1 execute tunnel-health --remote --command "SELECT * FROM transitions ORDER BY scheduled_at DESC LIMIT 20"
pnpm --dir backend exec wrangler d1 execute tunnel-health --remote --command "SELECT * FROM outages ORDER BY first_down_at DESC LIMIT 20"
pnpm --dir backend exec wrangler tail
```

[API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/get/) ·
[Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/) ·
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
