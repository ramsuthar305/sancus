# Sancus

**Sancus** is a lightweight, Node.js-based **API Gateway** that sits at the edge of your architecture. One YAML file per upstream service gives you routing, pluggable auth, geo-fencing, two-tier rate limiting, Redis-backed response caching, resilience knobs, and the operational endpoints and headers other gateways use.

---

## 🚀 Features

- Declarative YAML per service, JSON-Schema validated, hot-reloaded on change, `npm run check` to lint
- Typed path params (`{int:id}`, `{str:slug}`), exact-before-param matching, 404 / 405 + `Allow`
- Pluggable auth via the ForwardAuth contract (Traefik / APISIX / Envoy style) with a shared Redis token cache
- Optional geo-fencing against a GeoJSON polygon set (off until you ship polygons)
- Two-tier rate limiting: global per-IP token bucket + per-route Redis sliding window; `X-RateLimit-*`, `RateLimit-*`, `Retry-After`
- Response cache with `LRU`, `LFU`, `SWR` strategies; `X-Cache-Status`, `X-Cache-Key`, `Age`, `ETag` / 304, honours upstream `Cache-Control`
- Upstream `nodes` with round-robin and passive health, per-service `timeout`, `retries`, `circuitBreaker`, path `rewrite`, header add/remove
- Named policies (`ip-restriction` built in, drop your own into `policies/`)
- `X-Request-Id` honoured, echoed, forwarded, and on every JSON log line (pino)
- `/health`, `/health/ready`, `/metrics` (Prometheus), `/routes`, `DELETE /cache/:service`
- Multipart forwarding, SSE passthrough, gzip, keep-alive pooling, graceful drain on SIGTERM
- Optional Slack / Discord compatible webhook alerts

---

## 🧱 Project Structure

```
.
├── api_configs/          # One YAML per upstream service
├── policies/             # (Optional) custom policy modules, *.js
├── k8s/                  # (Optional) example manifests
├── in.json               # GeoJSON polygons treated as banned territory (empty = geo-fence off)
├── examples/geofence/    # sample polygon set
├── docker-compose.yml    # gateway + Redis in one command
└── src/
    ├── clients/          # ForwardAuth client
    ├── configs/          # logger, metrics, JSON schema
    ├── controllers/      # request pipeline
    ├── middlewares/      # request id, access log, metrics, IP limiter, multipart
    ├── policies/         # built-in policies
    ├── routes/           # admin + proxy routers
    ├── services/         # route registry, proxy, auth, cache, rate limit, policy registry, redis
    ├── commands/         # `check`
    └── __tests__/
```

---

## 🔧 Service Config

Requests to `/api/<service name>/<path>` are matched against the service's routes and proxied to the upstream with `/api/<service name>` stripped. See `api_configs/your_service_name.yml` and `src/configs/apiConfig.schema.json`.

```yaml
service:
  name: users
  nodes: [http://users-a:8080, http://users-b:8080]   # or: host: USERS_URL (env var) + port
  hosts: [api.example.com]        # optional Host allow-list
  rewrite: { from: "^/v1", to: "" } # optional regex on the upstream path
  timeout: 10000                  # ms waiting for upstream headers (default 60000)
  retries: 1                      # GET/HEAD/OPTIONS only, on connection errors
  circuitBreaker: { errorThresholdPercentage: 50, volumeThreshold: 10, resetTimeout: 30000 }
  headers: { add: { X-Gateway: sancus }, remove: [Cookie] }
  policies:
    ip-restriction: { allow: [10.0.0.0/8] }

apis:
  - name: Users
    routes:
      - path: /v1/users/{int:id}
        methods: [GET, PATCH]
      - path: /v1/public/search
        methods: [GET]
        bypass: [AUTH, GEO_FENCE]
        resolveUser: true           # AUTH bypassed but still identify the user if a token is sent
        rateLimit:
          perMinute: 120
          perDay: 5000
          key: USER_OR_IP           # IP | USER | API_KEY | USER_OR_IP | IP_USER
          group: search             # share this quota across every route with the same group
          hideHeaders: false
        cache:
          strategy: SWR             # LRU | LFU | SWR
          ttl: 300                  # seconds in Redis
          key: PATH_QUERY           # PATH | PATH_QUERY | PATH_QUERY_USER
          browserTtl: 60            # emits Cache-Control to clients
          varyHeaders: [Accept-Language]
          statusCodes: [200, 404]   # default 200, 301, 404
```

Validate without starting the gateway:

```bash
npm run check            # ./api_configs
npm run check -- ./cfg   # another directory
```

---

## ⚙️ Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address |
| `<SERVICE>_HOST` etc. | | Upstream base URL for services using `host:` |
| `CONFIG_DIR` / `CONFIG_WATCH` | `./api_configs` / `true` | Config location and hot reload |
| `POLICIES_DIR` | `./policies` | Custom policy modules |
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | Which peers may set X-Forwarded-For. The default covers a load balancer or ingress in private address space; list public proxies (e.g. Cloudflare CIDRs) explicitly. `false` is refused while the IP limiter is on |
| `IP_RATE_LIMIT_ENABLED` | `true` | Global per-IP limiter on/off |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Token cache, rate limits, response cache. Everything fails open without it |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | CORS origins, comma-separated, `/regex/` allowed |
| `AUTH_URL` | | Base URL of your token-verification service (`VERITAS_URL` accepted) |
| `AUTH_VERIFY_PATH` / `AUTH_VERIFY_METHOD` | `/v1/verify/token` / `POST` | Endpoint appended to `AUTH_URL` |
| `AUTH_TOKEN_IN` / `AUTH_TOKEN_FIELD` | `body` / `token` | Send the token as a JSON body field, or as a `header` (default `authorization`) |
| `AUTH_USER_ID_FIELD` | `id` | Dot-path in the 2xx JSON that identifies the user, e.g. `user.uuid` |
| `AUTH_REQUEST_HEADERS` | `authorization` | Client headers forwarded to the auth service |
| `AUTH_UPSTREAM_HEADERS` | | Auth-response headers copied onto the upstream request |
| `AUTH_CLIENT_HEADERS` | | Auth-response headers returned to the client on rejection |
| `AUTH_FORWARD_HEADER` | `X-AUTHORIZED-FOR-ID` | Header carrying the resolved user id upstream |
| `AUTH_TIMEOUT_MS` / `AUTH_CACHE_TTL` | `5000` / `60` | Auth call timeout, positive-result cache seconds |
| `AUTH_FAIL_OPEN` / `AUTH_STATUS_ON_ERROR` | `false` / `403` | Behaviour when the auth service is unreachable |
| `IP_RATE_LIMIT_CAPACITY` / `IP_RATE_LIMIT_REFILL_RATE` | `200` / `5` | Global per-IP bucket size and tokens per second |
| `IP_BLOCK_THRESHOLD` / `IP_BLOCK_WINDOW_MS` / `IP_BLOCK_DURATION_MS` | `20` / `60000` / `900000` | Block an IP after N 429s in the window, for the duration |
| `TRUSTED_IPS` | | Comma-separated IPs that skip both limiters |
| `UPSTREAM_TIMEOUT_MS` / `UPSTREAM_UNHEALTHY_TTL_MS` | `60000` / `30000` | Default upstream timeout; how long a failed node is skipped |
| `UPSTREAM_MAX_SOCKETS` | `256` | Keep-alive pool size per worker to each upstream |
| `WORKERS` | `1` | Gateway processes sharing the port (`cluster`); use the core count of the pod |
| `CACHE_LFU_MAX_ENTRIES` | `1000` | LFU eviction bound |
| `KEEP_ALIVE_TIMEOUT_MS` | `125000` | Must exceed your load balancer's idle timeout |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Drain window on SIGTERM before forced exit |
| `LOG_LEVEL` / `LOG_HEADERS_REDACT` / `LOG_HEADERS_DROP` | `info` / `authorization,cookie,set-cookie` / | pino level; headers masked or removed from access logs |
| `ALERT_WEBHOOK_URL` / `ALERT_COOLDOWN_MS` | / `60000` | Slack/Discord-compatible webhook (`DISCORD_WEBHOOK_URL` accepted); per-key dedupe |
| `ADMIN_TOKEN` | | If set, `/metrics`, `/routes` and `/cache` require `Authorization: Bearer <token>` |
| `GEOFENCE_FILE` | `./in.json` | GeoJSON of banned polygons |

---

## 🎓 Demo

`demo/` is a runnable mini-platform (auth service, a users service, two catalog replicas, Redis) plus a 17-step guided tour that exercises every feature with real requests. `cd demo && docker compose up --build`, then `./tour.sh`. See [demo/README.md](demo/README.md).

---

## ▶️ Quick start

```bash
git clone https://github.com/ramsuthar305/sancus.git && cd sancus
docker compose up          # gateway on :3000 + Redis; edit api_configs/*.yml and the URLs in docker-compose.yml
curl -i localhost:3000/health/ready
```

Prebuilt images: `ghcr.io/ramsuthar305/sancus:<version>` (multi-arch, node:22-slim, non-root).

## ▶️ Local development

```bash
npm install

cat > .env <<'ENV'
USERS_URL=http://localhost:8000
AUTH_URL=http://localhost:8001
REDIS_URL=redis://localhost:6379
ALLOWED_ORIGINS=http://localhost:5173
TRUST_PROXY=false
ENV

npm run check
npm run dev                  # ts-node + reload on change
npm run build && npm start   # production
npm test && npm run test:e2e # e2e needs a local Redis
```

New Relic is not bundled. If you want it: `npm i newrelic` and start with `node -r newrelic build/index.js`.

---

## 🔐 Authentication

Sancus does not implement auth itself. For every route without `AUTH` in `bypass` it calls your verification service using the ForwardAuth contract: the request carries `X-Forwarded-Method`, `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Forwarded-Uri`, `X-Forwarded-For` plus the client headers listed in `AUTH_REQUEST_HEADERS`, and the token either in the JSON body or as a header.

- `2xx` containing `AUTH_USER_ID_FIELD` → valid. The id is forwarded as `AUTH_FORWARD_HEADER`; headers listed in `AUTH_UPSTREAM_HEADERS` are copied onto the upstream request; the result is cached in Redis for `AUTH_CACHE_TTL` seconds.
- Any other status → the auth service's status and body are returned to the client verbatim (plus `AUTH_CLIENT_HEADERS`).
- Unreachable → `AUTH_STATUS_ON_ERROR`, or anonymous pass-through when `AUTH_FAIL_OPEN=true`.

Example for a service exposing `GET /me` with a bearer header that returns `{ "user": { "uuid": "..." } }`:

```
AUTH_URL=https://auth.internal
AUTH_VERIFY_PATH=/me
AUTH_VERIFY_METHOD=GET
AUTH_TOKEN_IN=header
AUTH_USER_ID_FIELD=user.uuid
AUTH_UPSTREAM_HEADERS=x-user-role
```

---

## 🌍 Geo-fencing

Off by default: the shipped `in.json` has no polygons. To enable it, put a GeoJSON `FeatureCollection` of **banned** polygons in `in.json` (or `GEOFENCE_FILE`); `examples/geofence/india-states.json` is a sample. Once enabled, routes without `GEO_FENCE` in `bypass` require an `X-COORDINATES: <lat>,<lon>` header. A point inside any polygon is rejected as banned territory (`SE0405`); missing or malformed coordinates return `SE0406` / `SE0407`. `GET /api/geo/check` answers the same question without proxying.

---

## 🧩 Policies

A policy is a named, schema-validated Express middleware referenced from YAML at service or route level. `ip-restriction` (`allow` / `deny`, CIDRs supported) is built in. Add your own as `policies/<name>.js`:

```js
module.exports = {
  name: 'require-header',
  priority: 10, // higher runs first
  schema: { type: 'object', required: ['header'], properties: { header: { type: 'string' } } },
  create: ({ header }) => (req, res, next) =>
    req.headers[header.toLowerCase()] ? next() : res.status(400).json({ message: `missing ${header}` }),
};
```

```yaml
routes:
  - path: /v1/import
    methods: [POST]
    policies:
      require-header: { header: X-Idempotency-Key }
```

Unknown policy names or invalid configs reject the config file at startup and on hot reload.

---

## 📡 Operations

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness, always 200 |
| `GET /health/ready` | 503 until config is loaded and Redis answers, and during shutdown |
| `GET /metrics` | Prometheus: `sancus_http_requests_total`, `sancus_http_request_duration_seconds`, `sancus_upstream_duration_seconds`, `sancus_upstream_up`, `sancus_config_reloads_total`, `sancus_cache_events_total`, `sancus_rate_limited_total` |
| `GET /routes` | Loaded services, routes, and registered policies |
| `DELETE /cache/:service` | Purge every cached response for a service |

Order of operations per request: match → policies → cache lookup for anonymous routes → geo-fence and auth → rate limit and cache lookup → proxy. A cache HIT is answered before the rate limiter runs, so rate limits count upstream work, not cached responses.

Response headers you can rely on: `X-Request-Id` on everything; `X-RateLimit-Limit` / `-Remaining` / `-Reset`, `RateLimit-Limit` / `-Remaining` / `-Reset` and `Retry-After` on rate-limited routes; `X-Cache-Status` (`HIT`, `MISS`, `STALE`, `BYPASS`), `X-Cache-Key`, `Age`, `ETag` on cached routes; `Allow` on 405.

Logs are JSON lines from pino with `requestId` on every entry. Set `LOG_LEVEL=debug` locally.

---

## ☸️ Kubernetes

```bash
kubectl apply -k k8s/
```

`k8s/` is a complete kustomize set: namespace, `sancus-env` ConfigMap, `sancus-secrets` Secret (example values, replace them), Deployment with liveness on `/health` and readiness on `/health/ready`, non-root security context, resource limits, ClusterIP Service, a generic nginx Ingress with ALB annotations in comments, HPA and PodDisruptionBudget. Set the image tag, hosts, upstream URLs and `TRUST_PROXY` for your network, and keep the load balancer idle timeout below `KEEP_ALIVE_TIMEOUT_MS`.

---

## 📈 Benchmarks

See [docs/BENCHMARKS.md](docs/BENCHMARKS.md): ~21k req/s per process, ~0.3 ms median overhead at 2k req/s, and a same-conditions comparison against Kong, APISIX, Traefik and KrakenD with the harness to reproduce it.

---

## 📜 License

MIT. See `LICENSE`.

---

## 🙌 Contributing

Pull requests and issues are welcome. Run `npm test` and `npm run check` before opening one.
