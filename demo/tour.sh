#!/usr/bin/env bash
# Guided tour of every gateway feature against the demo platform. Run after `docker compose up`
# (in demo/) or ./demo/run-local.sh.   GW=http://localhost:3000 NONINTERACTIVE=1 ./demo/tour.sh
GW=${GW:-http://localhost:3000}; ADMIN=${ADMIN_TOKEN:-demo}
B='\033[1m'; D='\033[2m'; C='\033[36m'; G='\033[32m'; R='\033[0m'
n=0
step()  { n=$((n+1)); echo; echo -e "${B}${C}── $n. $1${R}"; [ -n "${2:-}" ] && echo -e "${D}$2${R}"; }
note()  { echo -e "${G}   ▸ $1${R}"; }
pause() { [ -n "${NONINTERACTIVE:-}" ] || { echo -e "${D}   (enter to continue)${R}"; read -r; }; }
# show <curl args...>: prints the command, the status line, the interesting headers and a trimmed body
show()  { echo -e "${D}   \$ curl -i $*${R}"; : > /tmp/tour.b; curl -s -D /tmp/tour.h -o /tmp/tour.b "$@"; head -1 /tmp/tour.h | sed 's/^/   /'; grep -iE '^(x-request-id|x-cache-status|x-cache-key|age|etag|cache-control|vary|x-ratelimit-limit|x-ratelimit-remaining|x-ratelimit-reset|ratelimit-limit|retry-after|allow|www-authenticate|content-type|content-encoding|x-gateway):' /tmp/tour.h | tr -d '\r' | sed 's/^/     /'; [ -s /tmp/tour.b ] && head -c 400 /tmp/tour.b | sed 's/^/     /'; echo; }
code()  { curl -s -o /dev/null -w '%{http_code}' "$@"; }

curl -sf "$GW/health" >/dev/null || { echo "gateway not reachable at $GW — start it first (demo/README.md)"; exit 1; }
echo -e "${B}Sancus tour — gateway at $GW${R}"

step "Every response carries a request id" "Send X-Request-Id and it is honoured; omit it and one is minted. The same id reaches the upstream and every log line."
show "$GW/api/users/profile" -H 'Authorization: Bearer alice' -H 'X-Request-Id: tour-0001'
note "the users service echoed requestId=tour-0001 from the header the gateway forwarded"
pause

step "Auth is pluggable: the gateway calls your verifier, not the other way round" "No token -> 401. A bad token -> the verifier's own 401 body and WWW-Authenticate, passed through verbatim."
show "$GW/api/users/profile"
show "$GW/api/users/profile" -H 'Authorization: Bearer nope'
show "$GW/api/users/profile" -H 'Authorization: Bearer bob'
note "user=bob role=user came from the verifier's response: id -> X-AUTHORIZED-FOR-ID, X-User-Role copied via AUTH_UPSTREAM_HEADERS"
note "call it again: the token is cached in Redis for 60s, the auth service is not called (watch demo/.run/auth.log)"
pause

step "Response cache: MISS, then HIT, then 304" "GET /products is cached 8s (SWR). Look at X-Cache-Status, Age and ETag."
show "$GW/api/catalog/products"
sleep 0.3
show "$GW/api/catalog/products"
ETAG=$(grep -i '^etag' /tmp/tour.h | cut -d' ' -f2 | tr -d '\r')
show "$GW/api/catalog/products" -H "If-None-Match: $ETAG"
note "generatedAt did not change between the two 200s: the second came from Redis. 304 means the client's copy is still good."
pause

step "Stale-while-revalidate" "After 75% of the TTL the entry is STALE: served instantly, refreshed in the background, next call is a fresh HIT."
echo "   waiting 6.5s for the entry to go stale..."; sleep 6.5
show "$GW/api/catalog/products"
sleep 0.5
show "$GW/api/catalog/products"
note "STALE then HIT with a newer generatedAt: nobody waited for the upstream"
pause

step "The cache respects the upstream" "/private-data answers with Cache-Control: no-store, so it is never stored: BYPASS every time."
show "$GW/api/catalog/private-data"
show "$GW/api/catalog/private-data"
pause

step "Vary on request headers" "/search caches per Accept-Language (varyHeaders). en, fr, en again."
show "$GW/api/catalog/search?q=mug" -H 'Accept-Language: en'
show "$GW/api/catalog/search?q=mug" -H 'Accept-Language: fr'
show "$GW/api/catalog/search?q=mug" -H 'Accept-Language: en'
pause

step "Private per-user cache" "/api/users/orders uses key PATH_QUERY_USER: alice's cache is not bob's, and Cache-Control says private."
show "$GW/api/users/orders" -H 'Authorization: Bearer alice'
show "$GW/api/users/orders" -H 'Authorization: Bearer alice'
show "$GW/api/users/orders" -H 'Authorization: Bearer bob'
pause

step "Rate limiting with standard headers" "/inventory and /inventory/{id} share one quota (group inventory, 5/min). Watch X-RateLimit-Remaining fall, then 429 + Retry-After."
show "$GW/api/catalog/inventory"
echo "   sending 4 more requests..."; codes=""; for i in $(seq 1 4); do codes="$codes $(code "$GW/api/catalog/inventory")"; done; echo "   status codes:$codes"
show "$GW/api/catalog/inventory/2"
note "/inventory/2 is 429 although you never called it: the group shares the quota"
note "cached routes are different: a cache HIT is answered before the rate limiter runs, because a hit costs no upstream work. Rate-limit what is expensive."
pause

step "Two replicas, round-robin, passive health" "/admin/stats is not cached, so you can see servedBy alternate between catalog-a and catalog-b."
for i in 1 2 3 4; do curl -s "$GW/api/catalog/admin/stats" | tr -d '\n ' | sed 's/^/   /'; echo; done
note "stop catalog-b (docker stop demo-catalog-b-1, or kill it) and repeat: the first call retries onto catalog-a, then b is skipped for 30s"
pause

step "Timeouts become 504, not hung clients" "The catalog service has timeout: 1500 and /slow takes 2.5s."
show "$GW/api/catalog/slow"
pause

step "Circuit breaker" "/flaky always 500s. Once 3+ calls happened in the last 10s and more than 25% failed, the breaker opens: 503 + Retry-After without touching the upstream, for 15s."
for i in 1 2 3 4 5 6 7 8; do c=$(code "$GW/api/catalog/flaky"); printf '   /flaky -> %s\n' "$c"; [ "$c" = 503 ] && break; done
show "$GW/api/catalog/flaky"
note "SE0503 came from the gateway; the catalog log shows no more hits. The successful calls from the previous steps sit in the same rolling window, which is why it can take a call or two more than three. It half-opens after resetTimeout."
pause

step "Server-Sent Events stream straight through" "5 events, 400ms apart. Note the timestamps: nothing is buffered."
curl -sN "$GW/api/catalog/events" | while IFS= read -r line; do [ -n "$line" ] && printf '   %s  %s\n' "$(date +%T.%N | cut -c1-12)" "$line"; done
pause

step "Policies: built-in ip-restriction and your own module" "/admin/stats allows private IPs only. POST /orders requires X-Idempotency-Key via demo/policies/require-header.js."
show -X POST "$GW/api/catalog/orders" -H 'Content-Type: application/json' -d '{"item":"mug"}'
show -X POST "$GW/api/catalog/orders" -H 'Content-Type: application/json' -H 'X-Idempotency-Key: abc-123' -d '{"item":"mug"}'
pause

step "Correct status codes" "Unknown path -> 404. Known path, wrong method -> 405 with Allow."
show "$GW/api/catalog/nope"
show -X DELETE "$GW/api/catalog/products"
pause

step "Operations endpoints" "Readiness checks config + Redis; /routes and /metrics need the admin token."
show "$GW/health/ready"
echo "   \$ curl $GW/routes -H 'Authorization: Bearer $ADMIN'"; curl -s "$GW/routes" -H "Authorization: Bearer $ADMIN" | head -c 500 | sed 's/^/     /'; echo
echo "   \$ curl $GW/metrics -H 'Authorization: Bearer $ADMIN' | grep sancus_http_requests_total"; curl -s "$GW/metrics" -H "Authorization: Bearer $ADMIN" | grep '^sancus_http_requests_total' | head -6 | sed 's/^/     /'
show -X DELETE "$GW/cache/catalog" -H "Authorization: Bearer $ADMIN"
pause

step "Hot reload: drop a file in api_configs/" "A new service appears without a restart; an invalid file is rejected and the old config stays live."
CFG="$(cd "$(dirname "$0")" && pwd)/api_configs"
cat > "$CFG/hello.yml" <<'YML'
service: { name: hello, host: USERS_URL }
apis: [{ name: hello, routes: [{ path: /profile, methods: [GET], bypass: [AUTH], resolveUser: true }] }]
YML
sleep 1.5
show "$GW/api/hello/profile"
echo "   now breaking it..."; echo 'service: { name: hello }' > "$CFG/hello.yml"; sleep 1.5
show "$GW/api/hello/profile"
rm -f "$CFG/hello.yml"
note "still 200: the broken file was rejected (see gateway log + sancus_config_reloads_total{status=\"error\"}). File removed again."
pause

step "Geo-fencing (off in the demo)" "Enable it by pointing GEOFENCE_FILE at a polygon set and restarting:"
echo "     GEOFENCE_FILE=examples/geofence/india-states.json ./demo/run-local.sh"
echo "     curl -i $GW/api/catalog/products -H 'X-COORDINATES: 17.385,78.4867'   # inside Telangana -> SE0405"
echo "     curl -i $GW/api/catalog/products -H 'X-COORDINATES: 51.5,-0.1'        # London -> proxied"

echo; echo -e "${B}That's the tour. Next: edit demo/api_configs/*.yml while the gateway runs, add a service of your own, or read docs/BENCHMARKS.md.${R}"
