# Sancus demo

A small platform you can run in one command, then poke at with a guided tour. Every feature of the gateway is wired up here with a real upstream behind it, so you can see what each YAML line does.

```
                    ┌──────────────── Sancus :3000 ────────────────┐
  curl / browser ─▶ │ request id · auth · geo · rate limit · cache  │
                    │ policies · retries · breaker · metrics        │
                    └──┬───────────────┬──────────────────┬─────────┘
                       │               │                  │
                 auth :8001      users :8010      catalog-a :8020
             (token verifier)  (needs a token)    catalog-b :8021   ← round-robin, failover
                                                       ▲
                                              Redis :6379 (token cache, limits, response cache)
```

| Piece | What it teaches |
|---|---|
| `services/auth.js` | The ForwardAuth contract: what the gateway sends your verifier, what it expects back |
| `services/users.js` | What an upstream receives: `X-AUTHORIZED-FOR-ID`, `X-User-Role`, `X-Request-Id`, `X-Gateway` |
| `services/catalog.js` | Two replicas, a slow route, a flaky route, an SSE stream, a `no-store` route |
| `api_configs/users.yml` | Auth-required service, per-user rate limits, private per-user cache |
| `api_configs/catalog.yml` | `nodes` + retries + circuit breaker, grouped rate limits, SWR / LFU caches, `varyHeaders`, policies |
| `policies/require-header.js` | A custom policy in 8 lines |
| `tour.sh` | 17 steps, each one request with the headers to look at |

## Run it

**Docker** (gateway is built from the repo, services run on `node:22-slim`):

```bash
cd demo
docker compose up --build
# another terminal
./tour.sh
```

**No Docker** (Node 18+ and a local Redis):

```bash
npm ci && npm run build
./demo/run-local.sh          # starts auth, users, catalog-a, catalog-b and the gateway
./demo/tour.sh               # another terminal; NONINTERACTIVE=1 to run straight through
```

Service logs land in `demo/.run/` when running locally, and in `docker compose logs -f` otherwise. Keep them open: the auth log shows the gateway calling the verifier only once per token, the catalog logs show which replica served each request and which requests never reached it (cache hits, open breaker).

## Things to try after the tour

- Edit `api_configs/catalog.yml` while it runs: change a TTL, add `hideHeaders: true` to a rate limit, add `Accept` to `varyHeaders`. Save, and the next request uses it. Break the YAML and watch the gateway keep the last good config.
- Add your own service: write `services/notes.js`, add `api_configs/notes.yml` with `host: NOTES_URL` or `nodes: [...]`, export the URL, done.
- Stop `catalog-b` and call `/api/catalog/admin/stats` a few times. Then start it again and watch it come back after `UPSTREAM_UNHEALTHY_TTL_MS`.
- Turn the geo-fence on: `GEOFENCE_FILE=examples/geofence/india-states.json` and send `X-COORDINATES`.
- Point a browser at `http://localhost:3000/api/catalog/products`, open the network tab, and reload: `Cache-Control: public, max-age=5` from `browserTtl` means the second load never leaves the browser.
- Write a second policy: copy `policies/require-header.js`, change the name and `create`, reference it from a route.
- Run `npm run bench` and `docs/BENCHMARKS.md` to see what each feature costs.

Admin token for `/routes`, `/metrics` and `DELETE /cache/:service` is `demo`.
