#!/usr/bin/env bash
# The checks worth trusting, unfiltered.
#
# This exists because filtered gates lied. Twice.
#
# The work order specifies gates like `go test ./... -run 'Employee|Payroll'`,
# and a -run filter that matches nothing — or matches only some of what it was
# meant to — still exits 0. Go reports "ok ... [no tests to run]" and moves on.
# Both times it happened here the gate was green while tests were failing or not
# running at all, and both times it surfaced only because somebody ran the tests
# by name.
#
# So: no filters. Everything runs, and the exit code means what it says.
#
#   bash scripts/gate.sh          # the fast checks — build, vet, unit, migrations
#   bash scripts/gate.sh --chain  # adds the live-chain end-to-end runs
#
# The chain runs cost real testnet USDC and take minutes, which is why they are
# opt-in rather than the default. Everything else is cheap enough to run before
# every push.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WITH_CHAIN=0
[[ "${1:-}" == "--chain" ]] && WITH_CHAIN=1

failures=0
step() {
  local label="$1"; shift
  printf '\n=== %s ===\n' "$label"
  if "$@"; then
    printf '  ok   %s\n' "$label"
  else
    printf '  FAIL %s\n' "$label"
    failures=$((failures + 1))
  fi
}

step "api builds"            bash -c 'cd packages/api && go build ./...'
step "api vets clean"        bash -c 'cd packages/api && go vet ./...'
# -count=1 so a cached pass from before the last edit cannot stand in for a run.
step "api tests"             bash -c 'cd packages/api && go test ./... -count=1'
step "migrations round-trip" bash -c 'cd packages/api && go run ./cmd/migrate-check'
step "contracts"             bash -c 'cd packages/contracts && forge test'
step "workspace builds"      pnpm build
step "workspace tests"       pnpm test
step "app typechecks"        bash -c 'cd packages/app && npx tsc --noEmit'
step "app lints"             bash -c 'cd packages/app && npx eslint src --max-warnings 100'

if [[ "$WITH_CHAIN" == "1" ]]; then
  step "settlement end to end" bash scripts/e2e.sh
  step "payout end to end"     bash scripts/e2e-payout.sh
  step "payroll end to end"    bash scripts/e2e-payroll.sh
  step "live disperse"         pnpm tsx scripts/payroll-disperse-check.ts
fi

printf '\n'
if [[ "$failures" -gt 0 ]]; then
  printf '%d check(s) failed.\n' "$failures"
  exit 1
fi
printf 'All checks passed.\n'
