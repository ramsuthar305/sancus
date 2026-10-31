# Benchmarks

Numbers you can reproduce. `npm run bench` runs Sancus on your machine with one row per feature, so you can see what each one costs.

The tooling is the usual one for HTTP benchmarks: [wrk](https://github.com/wg/wrk) with `--latency` for throughput and percentiles, plus [oha](https://github.com/hatoo/oha) at a fixed request rate for latency that is not distorted by coordinated omission.

## Method

- Upstream returns a 25-byte static JSON body. On the host it is a 4-process Node server that does 220k req/s on its own; in Docker it is nginx. In both cases the upstream is never the bottleneck.
- wrk: `-t4 -c100 -d15s --latency` on the host, `-t2 -c100 -d15s` in Docker. 5 s warm-up, then two measured runs, median reported. Any non-2xx response fails the run; every table below had zero.
- oha: `-c100 -q2000 -z15s`, i.e. a fixed 2,000 req/s so the reported latency is service time plus real queueing, not saturation.
- Gateway CPU and RSS sampled with `ps` once a second during the run (sum over workers).
- Redis 8 on localhost for the token cache, rate limits and response cache.
- Gateway runs with `NODE_OPTIONS=--max-old-space-size=256`, the same heap limit the image sets.
- Access logs at `info` write to `/dev/null`; production writes to a log driver, which costs more, not less.

Hardware for the run below: Apple M4 (10 cores: 4 performance + 6 efficiency), 16 GB, macOS, Node 24. The Docker Desktop VM had **2 vCPU and 4 GB** shared by the gateway, the upstream and wrk. Treat the Docker numbers as relative, not absolute: everything in that table ran under the same 2-vCPU constraint.

## Sancus on the host, per feature

Single gateway process unless stated. "As shipped" is the default config: info-level access log on, global IP limiter on. "Tuned" is `LOG_LEVEL=warn IP_RATE_LIMIT_ENABLED=false`, the usual production setting behind a load balancer that already does per-IP protection.

| Scenario | req/s | p50 ms | p90 ms | p99 ms | CPU % | RSS MB |
|---|---|---|---|---|---|---|
| direct upstream (baseline) | 221,121 | 0.379 | 0.739 | 1.3 | – | – |
| proxy, as shipped (info log + IP limiter) | 21,181 | 4.36 | 6.37 | 8.06 | 137 | 259 |
| proxy, tuned | 27,452 | 3.44 | 5.16 | 7.45 | 131 | 207 |
| proxy + route rate limit | 23,401 | 4.18 | 6.54 | 8.85 | 137 | 220 |
| proxy + auth (cached token) | 22,235 | 4.39 | 6.32 | 8.61 | 130 | 222 |
| cache HIT | 40,429 | 2.3 | 3.15 | 6.08 | 133 | 239 |
| auth + rate limit + cache HIT | 28,819 | 3.26 | 4.78 | 6.27 | 113 | 240 |
| proxy, tuned, 4 workers | 36,394 | 2.42 | 4.8 | 8.79 | 455 | 882 |
| auth + rate limit + cache HIT, 4 workers | 47,094 | 1.96 | 3.01 | 6.45 | 447 | 1017 |

Read it as: one Node process proxies about 27k req/s at 100 concurrent connections. The access log and IP limiter together cost about 23%. A Redis-backed rate limit costs about 15% and a cached token check about 19%. A cache HIT skips the upstream and lifts throughput to 40k. Four workers (`WORKERS=4`) scale to 1.3× to 1.6× on this laptop; the sub-linear part is the efficiency cores and the load generator sharing the machine, not a lock in the gateway (limits and cache live in Redis, there is no shared state between workers).

### Latency at a fixed 2,000 req/s (oha)

| Scenario | achieved req/s | p50 ms | p90 ms | p99 ms | p99.9 ms |
|---|---|---|---|---|---|
| direct upstream (baseline) | 2,000 | 0.124 | 0.186 | 0.3 | 1.21 |
| proxy, tuned | 2,000 | 0.382 | 0.771 | 4.708 | 14.771 |
| auth + rate limit + cache HIT | 2,000 | 0.389 | 0.724 | 4.739 | 10.63 |
| proxy, tuned, 4 workers | 2,000 | 0.382 | 0.714 | 1.351 | 9.228 |

This is the number to quote for "what does the gateway add": the upstream alone answers in 0.12 ms median; through a single Sancus process it is 0.38 ms, so the gateway adds about 0.3 ms at the median and 4.4 ms at p99, and rate limiting, auth and cache together barely move the median. The p99.9 spikes are V8 garbage collection pauses; four workers spread them out.

## What the numbers mean

- One Sancus process handles about 27k req/s, and a 4-worker pod on 4 cores 36k to 47k. A service doing 5k req/s at peak needs one or two small pods.
- At realistic load the gateway adds about 0.3 ms at the median (the oha table). That is the number your users feel.
- Each worker uses about 210 to 260 MB under load. `NODE_OPTIONS=--max-old-space-size=256` (set in the image) trades a few percent of throughput for about 25% less memory than Node's default heap, and keeps the median latency at 0.38 ms.
- Plan capacity at half the measured maximum, and cache the routes that repeat.

## Reproduce

```bash
brew install wrk oha        # or your package manager
redis-server &              # local Redis
npm ci && npm run build
DURATION=15 npm run bench   # RUNS=2 CONNS=100 THREADS=4 RATE=2000 are the defaults; results in tests/bench/results/
```

The script prints the exact wrk and oha commands and stops on any non-2xx response. Run it on your own hardware for numbers you can plan with.
