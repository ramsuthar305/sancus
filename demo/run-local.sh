#!/usr/bin/env bash
# Run the demo without Docker: needs Node 18+ and a Redis on localhost:6379.
#   ./demo/run-local.sh        (from the repo root, after `npm run build`)
set -euo pipefail
cd "$(dirname "$0")/.."
redis-cli ping >/dev/null 2>&1 || { echo "Redis is not running on localhost:6379 (brew services start redis / docker run -p 6379:6379 redis)"; exit 1; }
[ -f build/index.js ] || npm run build
mkdir -p demo/.run
node demo/services/auth.js   > demo/.run/auth.log 2>&1 & PIDS=$!
PORT=8010 node demo/services/users.js > demo/.run/users.log 2>&1 & PIDS="$PIDS $!"
PORT=8020 REPLICA=a node demo/services/catalog.js > demo/.run/catalog-a.log 2>&1 & PIDS="$PIDS $!"
PORT=8021 REPLICA=b node demo/services/catalog.js > demo/.run/catalog-b.log 2>&1 & PIDS="$PIDS $!"
trap 'kill $PIDS 2>/dev/null; exit 0' INT TERM EXIT
echo "services: auth :8001, users :8010, catalog-a :8020, catalog-b :8021  (logs in demo/.run/)"
echo "gateway:  http://localhost:3000   admin token: demo   -> run ./demo/tour.sh in another terminal"
CONFIG_DIR=demo/api_configs POLICIES_DIR=demo/policies CONFIG_WATCH=true \
AUTH_URL=http://127.0.0.1:8001 AUTH_UPSTREAM_HEADERS=x-user-role AUTH_CLIENT_HEADERS=www-authenticate \
USERS_URL=http://127.0.0.1:8010 ADMIN_TOKEN=demo LOG_LEVEL=${LOG_LEVEL:-info} PORT=${PORT:-3000} \
node build/index.js
