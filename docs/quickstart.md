# Quickstart: your first settled payment

Every code block below is real and runnable against a locally running `packages/api`
devserver + live Arc testnet — nothing here is illustrative pseudo-code. These blocks are
extracted verbatim into `docs/quickstart-verbatim.sh` and run in CI; if that script
fails, the fix is to this doc, not to the script.

**Honesty note up front:** Conduit payments settle via Permit2, which means the payer's
wallet must produce a real EIP-712 signature — that step cannot be a bare `curl` command
in any HTTP API, ours included. In your own integration this signing happens in the payer's
browser wallet (see the hosted checkout flow). For this quickstart we use a small
Node helper (`sign-typed-data.mjs`, already in this repo) to play that role non-interactively
so the whole thing is scriptable end to end.

## 1. Start the API

This resolves the repo root from the script's own location so it works no matter what
directory you run it from (which is exactly what CI exercises — running this from a
scratch directory, not a repo checkout).

```bash
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
(cd "$REPO_ROOT/packages/api" && go run ./cmd/devserver > /tmp/quickstart-devserver.log 2>&1 &)
for i in $(seq 1 30); do curl -sf http://localhost:8080/healthz > /dev/null 2>&1 && break; sleep 1; done
```

## 2. Create an account and get a test key

```bash
ACCOUNT=$(curl -s -X POST http://localhost:8080/v1/accounts \
  -H 'content-type: application/json' \
  -d '{"name":"Quickstart Co","settle_currency":"EUR","settle_address":"0xf04a181eaB4CfABf7D13CCe64737782737cD0b22"}')
SK_KEY=$(echo "$ACCOUNT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["api_key"]["key"])')
```

## 3. Create a settlement intent

```bash
INTENT=$(curl -s -X POST http://localhost:8080/v1/settlement_intents \
  -H "Authorization: Bearer $SK_KEY" -H "Idempotency-Key: $(uuidgen)" -H 'content-type: application/json' \
  -d '{"amount":1000000,"settle_currency":"EUR","settle_address":"0xf04a181eaB4CfABf7D13CCe64737782737cD0b22","reference":"QUICKSTART"}')
INTENT_ID=$(echo "$INTENT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
```

## 4. Quote, sign, prepare, sign, confirm — settled for real

```bash
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
```

That's it — a real cross-currency settlement (USDC paid in, EUR delivered), signed, submitted,
and confirmed on-chain. `tx_hash` in the last response is a real transaction you can look up
on [ArcScan](https://testnet.arcscan.app).

## What just happened

```
created --(quote)--> quoted --(prepare)--> funding --(confirm)--> settling --> settled
```

The FX side has its own nested lifecycle inside `quoted`→`settled` above:

```
quoted -> trade_created -> presigned -> awaiting_signature -> submitted -> settled
                                                          (or: expired / failed)
```

See [FX timing model](./fx-timing.md) for why the quote step has a ~3.5 second window and
what that means for checkout vs. pre-priced invoices.

## Next steps

- [Error codes](./errors.md) — what each one means and how to handle it.
- [Webhook verification](./webhooks.md) — Node, Go, and Python.
- [Currencies](./currencies.md) — what's routable right now (generated, not hand-maintained).
