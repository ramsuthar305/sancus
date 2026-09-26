# Benchmarks

Numbers people can reproduce, not adjectives. Two harnesses ship with the repo:

- `npm run bench` — Sancus on the host, one row per feature, so you can see what each one costs.
- `tests/bench/compare/compare.sh` — Sancus, Traefik, Kong, APISIX and KrakenD in the same Docker network, same nginx upstream, same load generator, so the comparison is apples to apples.

Tooling follows what Kong, APISIX and KrakenD publish: [wrk](https://github.com/wg/wrk) with `--latency` for throughput and percentiles, plus [oha](https://github.com/hatoo/oha) at a fixed request rate for latency that is not distorted by coordinated omission.

## Method

- Upstream returns a 25-byte static JSON body. On the host it is a 4-process Node server that does 220k req/s on its own; in Docker it is nginx. In both cases the upstream is never the bottleneck.
- wrk: `-t4 -c100 -d15s --latency` on the host, `-t2 -c100 -d15s` in Docker. 5 s warm-up, then two measured runs, median reported. Any non-2xx response fails the run; every table below had zero.
- oha: `-c100 -q2000 -z15s`, i.e. a fixed 2,000 req/s so the reported latency is service time plus real queueing, not saturation.
- Gateway CPU and RSS sampled with `ps` once a second during the run (sum over workers).
- Redis 7 on localhost for the token cache, rate limits and response cache.
- Access logs at `info` write to `/dev/null`; production writes to a log driver, which costs more, not less.

Hardware for the run below: Apple M4 (10 cores: 4 performance + 6 efficiency), 16 GB, macOS, Node 24. The Docker Desktop VM had **2 vCPU and 4 GB** shared by the gateway, the upstream and wrk. Treat the Docker numbers as relative, not absolute: everything in that table ran under the same 2-vCPU constraint.

## Sancus on the host, per feature

Single gateway process unless stated. "As shipped" is the default config: info-level access log on, global IP limiter on. "Tuned" is `LOG_LEVEL=warn IP_RATE_LIMIT_ENABLED=false`, the usual production setting behind a load balancer that already does per-IP protection.

| Scenario | req/s | p50 ms | p90 ms | p99 ms | CPU % | RSS MB |
|---|---|---|---|---|---|---|
| direct upstream (baseline) | 2,20,211 | 0.388 | 0.728 | 1.26 | - | - |
| proxy, as shipped (info log + IP limiter) | 12,729 | 7.44 | 9.72 | 11.72 | 116 | 280 |
| proxy, tuned | 14,950 | 6.38 | 8.84 | 10.97 | 125 | 256 |
| proxy + route rate limit | 13,982 | 6.83 | 9.29 | 11.1 | 124 | 276 |
| proxy + auth (cached token) | 14,014 | 6.71 | 9.32 | 10.55 | 121 | 291 |
| cache HIT | 32,878 | 2.73 | 3.84 | 6.69 | 134 | 267 |
| auth + rate limit + cache HIT | 22,248 | 4.28 | 6.86 | 60.42 | 128 | 274 |
| proxy, tuned, 4 workers | 23,766 | 3.74 | 6.48 | 10.45 | 456 | 997 |
| auth + rate limit + cache HIT, 4 workers | 35,220 | 2.45 | 4.57 | 8.08 | 445 | 1023 |

Read it as: one Node process proxies about 15k req/s at 100 concurrent connections. The access log costs about 15%. A Redis-backed rate limit or a cached token check costs about 6% each. A cache HIT skips the upstream and more than doubles throughput. Four workers (`WORKERS=4`) scale to 1.6× to 2.4× on this laptop; the sub-linear part is the efficiency cores and the load generator sharing the machine, not a lock in the gateway (limits and cache live in Redis, there is no shared state between workers).

### Latency at a fixed 2,000 req/s (oha)

| Scenario | achieved req/s | p50 ms | p90 ms | p99 ms | p99.9 ms |
|---|---|---|---|---|---|
| proxy, tuned | 2,000 | 0.518 | 0.912 | 6.321 | 13.196 |
| auth + rate limit + cache HIT | 2,000 | 0.593 | 0.885 | 6.598 | 13.559 |
| proxy, tuned, 4 workers | 2,000 | 0.489 | 0.904 | 3.203 | 11.46 |

This is the number to quote for "what does the gateway add": at 2,000 req/s a single Sancus process answers a proxied request in about 0.5 ms median and 6 ms at p99, including the upstream round trip, with rate limiting, auth and cache adding roughly 0.1 ms.

## Sancus vs Kong, APISIX, Traefik, KrakenD (Docker, 2 vCPU)

Plain proxy of `GET /echo` to the same nginx upstream. Sancus runs the published `sancus:slim` image with `WORKERS=2`; Kong and APISIX run 2 nginx workers; Traefik and KrakenD use their defaults. Access logs off everywhere.

| Gateway | Runtime | req/s | p50 ms | p99 ms | RSS MB |
|---|---|---|---|---|---|
| nginx upstream direct | C | 349,000 | 0.12 | 2.1 | – |
| APISIX 3.9 | C / LuaJIT (OpenResty) | 74,100 | 1.3 | 2.9 | 78 |
| Kong 3.7 | C / LuaJIT (OpenResty) | 58,500 | 1.6 | 3.9 | 285 |
| Traefik 3.1 | Go | 46,200 | 2.0 | 6.6 | 116 |
| KrakenD 2.7 | Go | 25,600 | 3.7 | 11.4 | 37 |
| **Sancus 2.0** | Node 22 | **10,800** | **8.1** | **23.8** | 179 |

## Where Sancus stands

Honest reading: on raw proxy throughput Sancus is about 7× behind APISIX, 5× behind Kong, 4× behind Traefik and 2.4× behind KrakenD per core. That is the cost of a JavaScript HTTP stack (Express + http-proxy) versus nginx or Go. Per request it spends roughly 90 µs of CPU; APISIX spends about 13 µs.

What that means in practice:

- One Sancus process handles ~15k req/s, one 4-worker pod on 4 cores handles 25k to 35k. A service doing 5k req/s at peak, which is most products, needs one or two small pods. Throughput per pod is rarely the reason to pick a gateway at that scale.
- Latency added at realistic load is sub-millisecond at the median (the oha table), which is what users feel. The p99 gap versus nginx-based gateways is single-digit milliseconds.
- Memory per worker is higher than Go or C gateways. `NODE_OPTIONS=--max-old-space-size=256` (set in the image) trades ~2% throughput for a ~40% smaller RSS.

Where Sancus wins is not this table: one YAML per service, SWR/LFU caching, two-tier rate limiting, ForwardAuth, policies in plain JavaScript, a 5-minute setup. If your bottleneck is the gateway's CPU at 50k+ req/s per node, use APISIX or Kong. If it is developer time, this is the trade Sancus makes on purpose.

Roadmap items that would move the number, in order of expected gain: replace `http-proxy` with a direct `http.request` pipe (the library allocates per request and predates streams3), trim the Express middleware chain on the hot path, and pre-resolve per-route decisions (auth, cache, rate-limit applicability) at config load instead of per request. A raw Node proxy does 25k to 30k req/s per core, so roughly 2× is available before leaving JavaScript.

## Reproduce

```bash
brew install wrk oha        # or your package manager
redis-server &              # local Redis
npm ci && npm run build
npm run bench               # DURATION=15 RUNS=2 CONNS=100 THREADS=4 RATE=2000 are the defaults; results in tests/bench/results/

docker build -t sancus:slim .
tests/bench/compare/compare.sh 15 2    # duration, runs; SANCUS_IMAGE, WRK_THREADS, WRK_CONNS to override
```

Run it on a Linux box with dedicated cores and post the numbers; the harness prints the exact command lines and fails loudly on any non-2xx response.
