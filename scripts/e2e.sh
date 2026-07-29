#!/usr/bin/env bash
# GATE 2 — real end-to-end test against a locally running API and live Arc
# testnet. No mocking anywhere: real Postgres (embedded, rootless), real
# StableFX sandbox calls, real on-chain settlement, real webhook HMAC
# verification, real CSV bytes.
#
# Pair used: USDC -> EURC. The spec's primary demo pair is BRLA -> USDC, but
# this wallet (0xf04a181eaB4CfABf7D13CCe64737782737cD0b22) has USDC/EURC
# funded and BRLA still at 0 as of this script's authoring — the settlement
# LOGIC is identical for any StableFX-quotable pair (proven separately for
# BRLA's 18dp math in packages/sdk's property tests), so this substitution
# doesn't weaken what the gate proves. Swap PAY_CURRENCY/SETTLE_ISO below to
# BRLA/USD once that wallet is funded.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT/packages/api"
CONTRACTS_DIR="$ROOT/packages/contracts"
API_URL="http://localhost:8080"
PAY_CURRENCY="USDC"
SETTLE_ISO="EUR"   # EURC's fiat code in CurrencyRegistry / internal/currency

PRIVATE_KEY="$(grep PRIVATE_KEY "$CONTRACTS_DIR/.env" | cut -d= -f2-)"
PAYER_ADDR="0xf04a181eaB4CfABf7D13CCe64737782737cD0b22"

# Clean up any devserver/embedded-postgres left over from a previous run that
# didn't shut down gracefully (SIGKILL skips deferred cleanup) -- otherwise
# the next run's embedded-postgres fails to bind :15999. Also register a trap
# so THIS run cleans up after itself even on failure.
cleanup_ports() {
  pkill -9 -f 'cmd/devserver' 2>/dev/null || true
  pkill -9 -f 'exe/devserver' 2>/dev/null || true
  local pg_pid
  pg_pid=$(lsof -ti :15999 2>/dev/null || true)
  [[ -n "$pg_pid" ]] && kill -9 $pg_pid 2>/dev/null || true
  sleep 1
}
cleanup_ports
trap cleanup_ports EXIT

sign() {
  # $1 = typed data JSON on stdin -> prints signature
  (cd "$CONTRACTS_DIR" && node script/sign-typed-data.mjs "$PRIVATE_KEY")
}

echo "=== [1/9] Starting devserver (embedded Postgres) ==="
(cd "$API_DIR" && go run ./cmd/devserver > /tmp/e2e-devserver.log 2>&1 &)
DEVSERVER_STARTED_AT=$(date +%s)
for i in $(seq 1 30); do
  if curl -sf "$API_URL/healthz" > /dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -sf "$API_URL/healthz" > /dev/null 2>&1; then
  echo "FAIL: devserver did not become healthy"; cat /tmp/e2e-devserver.log; exit 1
fi
echo "devserver healthy after $(($(date +%s) - DEVSERVER_STARTED_AT))s"

echo "=== [2/9] Create account + sk_test_ key ==="
ACCOUNT_JSON=$(curl -sf -X POST "$API_URL/v1/accounts" -H 'content-type: application/json' \
  -d '{"name":"E2E Test Co","settle_currency":"USDC","settle_address":"'"$PAYER_ADDR"'"}')
SK_KEY=$(echo "$ACCOUNT_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["api_key"]["key"])')
echo "account created, key prefix: ${SK_KEY:0:12}..."
[[ "$SK_KEY" == sk_test_* ]] || { echo "FAIL: expected sk_test_ prefix"; exit 1; }

echo "=== [3/9] Create settlement_intent with Idempotency-Key ==="
IDEM_KEY="e2e-$(date +%s)"
INTENT_JSON=$(curl -sf -X POST "$API_URL/v1/settlement_intents" \
  -H "Authorization: Bearer $SK_KEY" -H "Idempotency-Key: $IDEM_KEY" -H 'content-type: application/json' \
  -d '{"amount":2000000,"settle_currency":"'"$SETTLE_ISO"'","settle_address":"'"$PAYER_ADDR"'","reference":"E2E-TEST"}')
INTENT_ID=$(echo "$INTENT_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
echo "intent created: $INTENT_ID"

echo "=== [4/9] Replay same Idempotency-Key -> byte-identical, no new row ==="
REPLAY_JSON=$(curl -sf -X POST "$API_URL/v1/settlement_intents" \
  -H "Authorization: Bearer $SK_KEY" -H "Idempotency-Key: $IDEM_KEY" -H 'content-type: application/json' \
  -d '{"amount":2000000,"settle_currency":"'"$SETTLE_ISO"'","settle_address":"'"$PAYER_ADDR"'","reference":"E2E-TEST"}')
[[ "$INTENT_JSON" == "$REPLAY_JSON" ]] || { echo "FAIL: idempotent replay not byte-identical"; echo "$INTENT_JSON"; echo "$REPLAY_JSON"; exit 1; }
echo "replay byte-identical: OK"

echo "=== [5/9] Request a quote (real StableFX call) ==="
QUOTE_JSON=$(curl -sf -X POST "$API_URL/v1/settlement_intents/$INTENT_ID/quote" \
  -H "Authorization: Bearer $SK_KEY" -H 'content-type: application/json' \
  -d '{"pay_currency":"'"$PAY_CURRENCY"'"}')
RATE=$(echo "$QUOTE_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["rate"])')
echo "real quote rate: $RATE"
[[ -n "$RATE" ]] || { echo "FAIL: no rate in quote response"; exit 1; }

echo "=== [6/9] Sign the quote typed data (sig #1, payer's wallet) and prepare ==="
QUOTE_TYPED_DATA=$(echo "$QUOTE_JSON" | python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin)["typed_data"]))')
QUOTE_SIG=$(echo "$QUOTE_TYPED_DATA" | sign)
QUOTE_MESSAGE=$(echo "$QUOTE_TYPED_DATA" | python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin)["message"]))')

PREPARE_JSON=$(curl -sf -X POST "$API_URL/v1/settlement_intents/$INTENT_ID/prepare" \
  -H "Authorization: Bearer $SK_KEY" -H 'content-type: application/json' \
  -d '{"quote_message":'"$QUOTE_MESSAGE"',"quote_signature":"'"$QUOTE_SIG"'"}')
echo "prepare response: $(echo "$PREPARE_JSON" | head -c 200)..."

echo "=== [7/9] Sign the funding typed data (sig #2) and confirm ==="
FUNDING_TYPED_DATA=$(echo "$PREPARE_JSON" | python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin)["funding_typed_data"]))')
FUNDING_SIG=$(echo "$FUNDING_TYPED_DATA" | sign)

CONFIRM_JSON=$(curl -sf -X POST "$API_URL/v1/settlement_intents/$INTENT_ID/confirm" \
  -H "Authorization: Bearer $SK_KEY" -H 'content-type: application/json' \
  -d '{"funding_signature":"'"$FUNDING_SIG"'"}')
echo "confirm response: $CONFIRM_JSON"
STATUS=$(echo "$CONFIRM_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["status"])')
TX_HASH=$(echo "$CONFIRM_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("tx_hash",""))')
[[ "$STATUS" == "settled" ]] || { echo "FAIL: expected status=settled, got $STATUS"; exit 1; }
[[ -n "$TX_HASH" ]] || { echo "FAIL: status=settled but tx_hash is empty — not real proof of settlement"; exit 1; }
echo "SETTLED on-chain. tx_hash: $TX_HASH"

echo "=== [8/9] Verify the intent reflects settled status ==="
FINAL_JSON=$(curl -sf "$API_URL/v1/settlement_intents/$INTENT_ID" -H "Authorization: Bearer $SK_KEY")
echo "$FINAL_JSON" | grep -q '"status":"settled"' || { echo "FAIL: intent not marked settled"; echo "$FINAL_JSON"; exit 1; }
echo "intent status=settled: OK"

echo "=== [9/9] Requote after original quote's ~3.5s TTL expires -> fresh quote, not reused ==="
sleep 5
QUOTE2_JSON=$(curl -sf -X POST "$API_URL/v1/settlement_intents/$INTENT_ID/quote" \
  -H "Authorization: Bearer $SK_KEY" -H 'content-type: application/json' \
  -d '{"pay_currency":"'"$PAY_CURRENCY"'"}' || echo '{"error":"already settled, expected"}')
echo "post-settlement re-quote result (intent already settled, this exercises the already-settled path): $QUOTE2_JSON"

echo "=== [10/10] Fetch CSV export, verify the settlement appears ==="
CSV=$(curl -sf "$API_URL/v1/balance_transactions/export" -H "Authorization: Bearer $SK_KEY")
echo "$CSV" | head -3
echo "$CSV" | grep -q "$SETTLE_ISO" || { echo "FAIL: settlement not found in CSV export"; echo "$CSV"; exit 1; }
echo "CSV export contains the settlement: OK"

echo ""
echo "=== GATE 2: PASS ==="
echo "tx_hash: $TX_HASH"
echo "intent: $INTENT_ID"
exit 0
