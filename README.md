# Tunnel Health

Record Cloudflare Tunnel connectivity every minute in D1, as a load-shedding
tracker for a Dhaka homelab without battery backup. This is a standalone project;
the existing homelab status page is independent.

## What it does

A scheduled Cloudflare Worker queries one tunnel's official API and inserts a
timestamped observation. No browser or homelab process needs to remain online.
There is no public data endpoint or dashboard yet. Credentials stay in a Worker
secret. The collector has no runtime package dependencies.

- `healthy` and `degraded` mean connected; `down` means disconnected.
- API failures, timeouts and invalid responses are stored as `unknown`.
- `inactive` is preserved separately; it is not assumed to be a power outage.
- Each scheduled minute has a unique key, so duplicate deliveries keep the first
  saved observation. Inserts may arrive out of order without corrupting events.
- The `outages` SQL view groups consecutive down samples. Adjacent healthy or
  degraded samples establish recovery. Unknown/inactive samples and missing
  minutes end a segment with an uncertain outcome. A final down segment is open;
  always check observation freshness before calling an open event ongoing.
- Connection timestamps from Cloudflare are preserved for future analysis.
  Event boundaries currently use observation times, not inferred electricity
  timestamps. Boot delays and outages shorter than the poll interval affect accuracy.

All timestamps use UTC ISO strings. A future dashboard should use `Asia/Dhaka`
for display and daily aggregation. An outage crossing midnight must be split
across the relevant local days when calculating daily totals. Uncertain segments
must not be counted as known continuous downtime.

## Setup

Requires Node.js 24+ and a Cloudflare account with the tunnel already configured.

```sh
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm exec wrangler d1 create tunnel-health
```

Edit `wrangler.jsonc`: replace the D1 database ID, Cloudflare account ID and tunnel
ID. Create a Cloudflare API token scoped to the account with **Cloudflare Tunnel:
Read** permission. This is an API token, not the tunnel connector token.

```sh
pnpm exec wrangler secret put CLOUDFLARE_API_TOKEN
pnpm db:remote
pnpm deploy
```

Wrangler may offer to create the Worker while uploading its first secret. The
cron expression `* * * * *` runs every minute. Trigger changes can take up to 15
minutes to propagate. No Cloudflare Pro domain is needed. The configuration
disables workers.dev and preview URLs; this is a scheduled collector only.

At one sample per minute, expect 1,440 invocations and base row inserts daily,
plus index-write accounting. This is below the free daily allowances of 100,000
Worker requests and 100,000 D1 row writes, assuming other account usage leaves
room. Free scheduled Workers have a 10 ms CPU budget; network/database waiting
does not count, but check actual CPU usage after deployment. API usage is five
requests per five minutes versus the shared 1,200-request limit.

## Local verification

```sh
pnpm test
pnpm check
pnpm db:local
cp .dev.vars.example .dev.vars
# Set a real read token in .dev.vars and account/tunnel IDs in wrangler.jsonc.
pnpm dev
```

In another terminal, invoke the local scheduled handler:

```sh
curl 'http://localhost:8787/__scheduled?cron=*+*+*+*+*'
```

The local handler reads the real tunnel API but writes to local D1. Tests use
mocked HTTP responses and real in-memory SQLite, requiring no credentials.
Never commit `.dev.vars`. GitHub Actions runs tests and a bundle dry run.

## Inspect collected data

```sh
pnpm exec wrangler d1 execute tunnel-health --remote --command "SELECT * FROM observations ORDER BY scheduled_at DESC LIMIT 20"
pnpm exec wrangler d1 execute tunnel-health --remote --command "SELECT * FROM outages ORDER BY first_down_at DESC LIMIT 20"
pnpm exec wrangler tail
```

Check that recent samples exist and that errors are not recurring. Database
failures fail the invocation; API errors are persisted as unknown observations
and produce a log entry without credentials or API response bodies.

Observations are retained indefinitely for now (about 525,600/year). Monitor D1
storage and add a retention/rollup policy before reaching its free database size
limit. The outage view scans history, appropriate for initial manual queries;
materialize aggregates before building a heavily queried dashboard.

## GitHub

This folder is intended to be its own Git repository. After creating an empty
GitHub repository, connect and push it:

```sh
git remote add origin git@github.com:YOUR_USERNAME/tunnel-health.git
git push -u origin main
```

## References

- [Tunnel API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/get/)
- [Cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [API rate limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/)
