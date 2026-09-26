# Benchmarks

Numbers you can reproduce. `npm run bench` runs Sancus on your machine with one row per feature, so you can see what each one costs.

The tooling is the usual one for HTTP benchmarks: [wrk](https://github.com/wg/wrk) with `--latency` for throughput and percentiles, plus [oha](https://github.com/hatoo/oha) at a fixed request rate for latency that is not distorted by coordinated omission.

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
| direct upstream (baseline) | 2,19,058 | 0.394 | 0.703 | 1.29 | – | – |
| proxy, as shipped (info log + IP limiter) | 16,574 | 5.66 | 7.75 | 8.81 | 121 | 283 |
| proxy, tuned | 21,398 | 4.45 | 6.49 | 7.98 | 125 | 269 |
| proxy + route rate limit | 18,313 | 5.13 | 7.46 | 8.7 | 125 | 278 |
| proxy + auth (cached token) | 18,722 | 5 | 7.33 | 8.68 | 126 | 266 |
| cache HIT | 32,376 | 2.89 | 4.2 | 7.38 | 133 | 274 |
| auth + rate limit + cache HIT | 21,494 | 4.36 | 6.52 | 8.18 | 131 | 268 |
| proxy, tuned, 4 workers | 30,814 | 2.9 | 5.28 | 9.56 | 439 | 996 |
| auth + rate limit + cache HIT, 4 workers | 37,130 | 2.44 | 4.2 | 7.56 | 441 | 1009 |

Read it as: one Node process proxies about 21k req/s at 100 concurrent connections. The access log costs about 20%. A Redis-backed rate limit or a cached token check costs about 13% each. A cache HIT skips the upstream and lifts throughput to 32k. Four workers (`WORKERS=4`) scale to 1.4× to 1.7× on this laptop; the sub-linear part is the efficiency cores and the load generator sharing the machine, not a lock in the gateway (limits and cache live in Redis, there is no shared state between workers).

### Latency at a fixed 2,000 req/s (oha)

| Scenario | achieved req/s | p50 ms | p90 ms | p99 ms | p99.9 ms |
|---|---|---|---|---|---|
| direct upstream (baseline) | 2,000 | 0.128 | 0.208 | 0.411 | 3.094 |
| proxy, tuned | 2,000 | 0.411 | 0.816 | 6.621 | 24.307 |
| auth + rate limit + cache HIT | 2,000 | 0.5 | 0.759 | 7.441 | 106.675 |
| proxy, tuned, 4 workers | 2,000 | 0.4 | 0.783 | 3.035 | 16.275 |

This is the number to quote for "what does the gateway add": the upstream alone answers in 0.13 ms median; through a single Sancus process it is 0.41 ms, so the gateway adds about 0.3 ms at the median and 6 ms at p99, with rate limiting, auth and cache adding roughly 0.1 ms more. The p99.9 spikes are V8 garbage collection pauses; four workers spread them out.

## What the numbers mean

- One Sancus process handles about 21k req/s, and a 4-worker pod on 4 cores 30k to 37k. A service doing 5k req/s at peak needs one or two small pods.
- At realistic load the gateway adds about 0.3 ms at the median (the oha table). That is the number your users feel.
- Each worker uses about 250 MB under load. `NODE_OPTIONS=--max-old-space-size=256` (set in the image) trades about 2% throughput for about 40% less memory.
- Plan capacity at half the measured maximum, and cache the routes that repeat.

### What the profiling found, and what it changed

To see where the per-request cost lives, four proxies were measured against the same upstream on the host (single process, 100 connections):

| Stack | req/s | CPU per request |
|---|---|---|
| raw Node `http.request` pipe, no framework | 42,100 | 24 µs |
| the `http-proxy` library alone | 24,200 | 41 µs |
| Express + `http-proxy`, no gateway logic | 15,800 | 63 µs |
| Sancus 2.0 before this change | 14,900 | 67 µs |

All of Sancus's own logic (route matching, auth, rate limit, cache, policies, metrics, request ids) cost 6%. The `http-proxy` library cost 42% and Express 35%. So `http-proxy` was replaced with a direct `http.request` pipe (`src/services/proxy.service.ts`), keeping Express:

| | before | after |
|---|---|---|
| proxy, tuned, 1 process | 14,900 req/s, p50 6.4 ms, p99 10.9 ms | 21,400 req/s, p50 4.5 ms, p99 8.0 ms |
| auth + rate limit + cache HIT, 4 workers | 35,200 req/s | 37,100 req/s |

The same benchmark run also caught a real bug: the upstream connection pool capped free sockets at 32, so under load it churned sockets, produced 16,000 TIME_WAIT entries in eight seconds and then failed with `EADDRNOTAVAIL` (502s). The pool is now uncapped (`UPSTREAM_MAX_SOCKETS`, default 256) and every table above has zero non-2xx responses.

The remaining lever is Express itself: a plain `http` server with the same middleware as functions would land around 33k to 38k req/s per process. It is not done because four workers already pass that number, and it touches every middleware.

## Reproduce

```bash
brew install wrk oha        # or your package manager
redis-server &              # local Redis
npm ci && npm run build
npm run bench               # DURATION=15 RUNS=2 CONNS=100 THREADS=4 RATE=2000 are the defaults; results in tests/bench/results/
```

The script prints the exact wrk and oha commands and stops on any non-2xx response. Run it on your own hardware for numbers you can plan with.
