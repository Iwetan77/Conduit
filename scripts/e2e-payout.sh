#!/usr/bin/env bash
# End-to-end withdrawal against a live Arc testnet. No mocking anywhere: real
# Postgres (embedded, rootless), a real Circle wallet provisioned through a real
# browser challenge, a real on-chain transfer, real balances read back.
#
# What it proves, and the second half matters as much as the first:
#   - a business can withdraw from its own settlement wallet to an address it
#     has proven it controls, and both balances move by the right amounts
#   - a withdrawal to an UNVERIFIED destination is refused
#
# The body is TypeScript because provisioning and signing both go through
# Circle's Web SDK, which needs a browser -- see scripts/circle-challenge.ts.
# This brings the API up around it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT/packages/api"
API_URL="${CONDUIT_API_URL:-http://localhost:8080}"

# Clear anything a previous run left bound. SIGKILL skips deferred cleanup, so
# an interrupted run leaves embedded-postgres holding :15999 and the next run
# cannot start.
cleanup() {
  pkill -9 -f 'cmd/devserver' 2>/dev/null || true
  pkill -9 -f 'exe/devserver' 2>/dev/null || true
  local pg_pid
  pg_pid=$(lsof -ti :15999 2>/dev/null || true)
  [[ -n "$pg_pid" ]] && kill -9 $pg_pid 2>/dev/null || true
  sleep 1
}
cleanup
trap cleanup EXIT

echo "starting the API…"
(cd "$API_DIR" && go run ./cmd/devserver > /tmp/e2e-payout-devserver.log 2>&1 &)
for _ in $(seq 1 60); do
  curl -sf "$API_URL/healthz" > /dev/null 2>&1 && break
  sleep 1
done
curl -sf "$API_URL/healthz" > /dev/null 2>&1 || {
  echo "the API never came up; see /tmp/e2e-payout-devserver.log"
  tail -20 /tmp/e2e-payout-devserver.log
  exit 1
}

cd "$ROOT"
CONDUIT_API_URL="$API_URL" pnpm tsx scripts/e2e-payout.ts
