# Sancus

**Sancus** is a lightweight, Node.js-based **API Gateway** designed to sit at the edge of your application architecture. It offers declarative YAML routing, pluggable auth and geo-fencing, two-tier rate limiting, Redis-backed response caching, and optional Kubernetes manifests.

---

## 🚀 Features

- Declarative YAML-based API configuration, pre-compiled into a route registry at startup
- Multiple upstream services with per-route method matching and typed path params (`{int:id}`, `{str:slug}`)
- Middleware bypass per route (`AUTH`, `GEO_FENCE`)
- Token verification via an external auth service, with a shared Redis token cache
- Two-tier rate limiting: global per-IP token bucket + per-route Redis sliding window (`IP`, `USER`, `API_KEY`, `USER_OR_IP`)
- Per-route response caching with `LRU`, `LFU`, or `SWR` (stale-while-revalidate) strategies and optional browser cache headers
- Multipart/form-data forwarding with file validation
- Server-Sent Events passthrough (no compression, no buffering)
- gzip compression, keep-alive connection pooling to upstreams, graceful shutdown
- Optional Discord alerts for 5xx responses, proxy errors, and rate-limit breaches
- Correlation IDs on every request, forwarded upstream as `Correlation-ID`

---

## 🧱 Project Structure

```
.
├── api_configs/          # One YAML per upstream service
├── k8s/                  # (Optional) example deployment, service, and ingress manifests
├── in.json               # GeoJSON polygon(s) used by the GEO_FENCE check
└── src/
    ├── clients/          # Auth service client
    ├── controllers/      # Request pipeline (validate → geo-fence → auth → rate-limit → cache → proxy)
    ├── middlewares/      # IP rate limiter, multipart handler, request logger
    ├── services/         # Route registry, Redis, rate limit, cache
    ├── utils/            # CORS, URL parsing, config validation, alerts
    └── __tests__/        # Jest suites
```

---

## 🔧 API Config Format

See `api_configs/your_service_name.yml` for a complete example.

```yaml
service:
  name: your_service_name   # URL prefix: /api/your_service_name/...
  host: YOUR_SERVICE_HOST   # env var holding the upstream base URL
  port: 80

apis:
  - name: Example resource
    routes:
      - path: /v1/example/api/{int:id}
        methods: [GET, PATCH]
      - path: /v1/public/search
        methods: [GET]
        bypass: [AUTH, GEO_FENCE]
        rateLimit:
          perMinute: 120
          perDay: 5000
          key: USER_OR_IP
        cache:
          strategy: LRU
          ttl: 300
          key: PATH_QUERY
          browserTtl: 60
```

Requests to `/api/<service name>/<path>` are validated against the config and proxied to `<host>/<path>`.

---

## ⚙️ Environment Variables

| Variable | Required | Description |
|---|---|---|
| `<SERVICE>_HOST` (per config) | yes | Upstream base URL for each service, e.g. `YOUR_SERVICE_HOST=http://my-service` |
| `AUTH_URL` | yes | Base URL of your token-verification service |
| `AUTH_VERIFY_PATH` / `AUTH_VERIFY_METHOD` | no | Endpoint appended to `AUTH_URL` (default `/v1/verify/token`, `POST`) |
| `AUTH_TOKEN_IN` / `AUTH_TOKEN_FIELD` | no | Send the token in the JSON `body` (default, field `token`) or as a `header` (default `authorization`) |
| `AUTH_USER_ID_FIELD` | no | Dot-path in the auth response that identifies the user (default `id`), e.g. `user.uuid` |
| `AUTH_FORWARD_HEADER` | no | Header carrying that id to upstreams (default `X-AUTHORIZED-FOR-ID`) |
| `AUTH_TIMEOUT_MS` | no | Auth call timeout (default `5000`) |
| `REDIS_URL` | no | Defaults to `redis://127.0.0.1:6379`. Used for token cache, per-route rate limits, and response cache. Gateway fails open if Redis is down |
| `ALLOWED_ORIGINS` | no | Comma-separated CORS origins. Wrap in slashes for a regex: `/\.example\.com$/`. Defaults to `http://localhost:5173` |
| `IP_RATE_LIMIT_CAPACITY` | no | Global per-IP burst tokens (default `200`) |
| `IP_RATE_LIMIT_REFILL_RATE` | no | Tokens refilled per second (default `5`) |
| `TRUSTED_IPS` | no | Comma-separated IPs that bypass the IP limiter |
| `DISCORD_WEBHOOK_URL` | no | If set, sends alerts for 5xx, proxy errors, and rate-limit breaches |
| `KEEP_ALIVE_TIMEOUT_MS` | no | Server keep-alive timeout (default `125000`). Must exceed your load balancer's idle timeout |
| `NEW_RELIC_LICENSE_KEY` | no | Only needed if you start with `node -r newrelic` |
| `HOST` / `NODE_ENV` | no | Bind address (default `0.0.0.0`) and environment |

---

## ▶️ Setup

```bash
git clone https://github.com/ramsuthar305/sancus.git
cd sancus
npm install

cat > .env <<'ENV'
YOUR_SERVICE_HOST=http://localhost:8000
AUTH_URL=http://localhost:8001
REDIS_URL=redis://localhost:6379
ALLOWED_ORIGINS=http://localhost:5173
ENV

npm run build && npm start   # or: npm run dev
npm test
```

The gateway listens on port `3000`.

---

## 🔐 Authentication

Sancus does not implement auth itself. For every route without `AUTH` in `bypass`, it takes the incoming `Authorization` header value and calls your verification service as configured by the `AUTH_*` variables. A `2xx` response containing `AUTH_USER_ID_FIELD` means the token is valid; `401` means invalid. Results are cached in Redis for 60s. The resolved id is forwarded upstream as `AUTH_FORWARD_HEADER` and used for `USER`-keyed rate limits and caches.

Example for a service that expects `GET /me` with a bearer header and returns `{ "user": { "uuid": "..." } }`:

```
AUTH_URL=https://auth.internal
AUTH_VERIFY_PATH=/me
AUTH_VERIFY_METHOD=GET
AUTH_TOKEN_IN=header
AUTH_USER_ID_FIELD=user.uuid
```

---

## 🌍 Geo-fencing

Routes without `GEO_FENCE` in `bypass` require an `X-COORDINATES: <lat>,<lon>` header. If the point falls inside any polygon in `in.json`, the request is rejected as a banned territory (`SE0405`). Missing or malformed coordinates return `SE0406` / `SE0407`. Replace the shipped GeoJSON with your own blocked regions, or ship an empty `FeatureCollection` to disable blocking while keeping the header requirement.

---

## ☸️ Kubernetes

`k8s/` contains example manifests. Point `deployment.yaml` at your image, put env vars in a `sancus-env` secret, and adjust ingress hosts. If you sit behind an AWS ALB, set the ALB idle timeout below `KEEP_ALIVE_TIMEOUT_MS`.

---

## 📜 License

MIT. See `LICENSE`.

---

## 🙌 Contributing

Pull requests and issues are welcome.
