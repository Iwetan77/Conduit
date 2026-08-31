#!/usr/bin/env bash
# Mechanically extracted from docs/quickstart.md -- do not hand-edit.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
(cd "$REPO_ROOT/packages/api" && go run ./cmd/devserver > /tmp/quickstart-devserver.log 2>&1 &)
for i in $(seq 1 30); do curl -sf http://localhost:8080/healthz > /dev/null 2>&1 && break; sleep 1; done

ACCOUNT=$(curl -s -X POST http://localhost:8080/v1/accounts \
  -H 'content-type: application/json' \
  -d '{"name":"Quickstart Co","settle_currency":"EUR","settle_address":"0xf04a181eaB4CfABf7D13CCe64737782737cD0b22"}')
SK_KEY=$(echo "$ACCOUNT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["api_key"]["key"])')

INTENT=$(curl -s -X POST http://localhost:8080/v1/settlement_intents \
  -H "Authorization: Bearer $SK_KEY" -H "Idempotency-Key: $(uuidgen)" -H 'content-type: application/json' \
  -d '{"amount":1000000,"settle_currency":"EUR","reference":"QUICKSTART"}')
INTENT_ID=$(echo "$INTENT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')

PRIVATE_KEY="$(grep PRIVATE_KEY "$REPO_ROOT/packages/contracts/.env" | cut -d= -f2-)"
sign() { (cd "$REPO_ROOT/packages/contracts" && node script/sign-typed-data.mjs "$PRIVATE_KEY"); }

QUOTE=$(curl -s -X POST http://localhost:8080/v1/settlement_intents/$INTENT_ID/quote \
  -H "Authorization: Bearer $SK_KEY" -H 'content-type: application/json' -d '{"pay_currency":"USDC"}')
QUOTE_MSG=$(echo "$QUOTE" | python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin)["typed_data"]["message"]))')
QUOTE_SIG=$(echo "$QUOTE" | python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin)["typed_data"]))' | sign)

PREPARE=$(curl -s -X POST http://localhost:8080/v1/settlement_intents/$INTENT_ID/prepare \
  -H "Authorization: Bearer $SK_KEY" -H 'content-type: application/json' \
  -d '{"quote_message":'"$QUOTE_MSG"',"quote_signature":"'"$QUOTE_SIG"'"}')
FUNDING_SIG=$(echo "$PREPARE" | python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin)["funding_typed_data"]))' | sign)

curl -s -X POST http://localhost:8080/v1/settlement_intents/$INTENT_ID/confirm \
  -H "Authorization: Bearer $SK_KEY" -H 'content-type: application/json' \
  -d '{"funding_signature":"'"$FUNDING_SIG"'"}'
# {"status":"settled","tx_hash":"0x..."} <- real Arc testnet transaction

