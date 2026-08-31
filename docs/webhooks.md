# Webhook verification

Every delivery carries a `Conduit-Signature` header: `t=<unix>,v1=<hex>` where
`v1 = HMAC-SHA256(endpoint_secret, "<t>.<raw_body>")`. Reject if `|now - t| > 300` seconds.
**Always verify against the raw request body bytes**, before any JSON parsing — most web
frameworks parse the body before your handler sees it, which will break verification if
you compute the HMAC over the re-serialized object instead of what was actually sent.

## Node — `@conduit/node`

Tested against real signed deliveries from `packages/api/internal/webhooks`'s `Sign()`
(see `packages/node/src/webhooks.test.ts` — five tests, including tampered-body,
wrong-secret, and stale-timestamp rejection).

```js
import { constructEvent, ConduitSignatureVerificationError } from "@conduit/node";

app.post("/webhooks/conduit", express.raw({ type: "application/json" }), (req, res) => {
  try {
    const event = constructEvent(req.body, req.headers["conduit-signature"], process.env.CONDUIT_WEBHOOK_SECRET);
    // event.type, event.data
    res.sendStatus(200);
  } catch (err) {
    if (err instanceof ConduitSignatureVerificationError) return res.sendStatus(400);
    throw err;
  }
});
```

## Go

Same algorithm as `packages/api/internal/webhooks.Verify` (which this doc's snippet
mirrors exactly, minus the internal-package fields):

```go
func verifyConduitSignature(secret, header string, body []byte) error {
	var ts int64
	var v1 string
	if _, err := fmt.Sscanf(header, "t=%d,v1=%s", &ts, &v1); err != nil {
		return fmt.Errorf("malformed signature header")
	}
	age := time.Now().Unix() - ts
	if age > 300 || age < -300 {
		return fmt.Errorf("timestamp outside tolerance")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(fmt.Sprintf("%d", ts)))
	mac.Write([]byte("."))
	mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(v1)) {
		return fmt.Errorf("signature mismatch")
	}
	return nil
}
```

## Python

```python
import hmac
import hashlib
import time
import re

def verify_conduit_signature(secret: str, header: str, body: bytes) -> None:
    match = re.match(r"^t=(\d+),v1=([0-9a-f]+)$", header)
    if not match:
        raise ValueError("malformed signature header")
    ts, v1 = int(match.group(1)), match.group(2)

    if abs(time.time() - ts) > 300:
        raise ValueError("timestamp outside tolerance")

    mac = hmac.new(secret.encode(), digestmod=hashlib.sha256)
    mac.update(f"{ts}.".encode())
    mac.update(body)
    expected = mac.hexdigest()

    if not hmac.compare_digest(expected, v1):
        raise ValueError("signature mismatch")
```

## Retry behavior

Ladder: 0s, 5s, 30s, 2m, 10m, 1h, 6h, then dead-lettered. Every attempt (including
failures) is persisted with response code and a truncated response body —
`GET /v1/webhook_endpoints/:id/deliveries` shows the full log, and
`POST /v1/webhook_deliveries/:id/replay` re-sends any individual delivery on demand
(the dashboard's Developers screen has a Replay button wired to this).

## Events

**Sent today:**

- `settlement.succeeded`
- `payroll.run.completed` — every line in the run paid
- `payroll.run.partial` — one currency group paid and another did not
- `payroll.run.failed` — nothing was paid

**Defined but NOT sent:** `settlement_intent.created`, `settlement_intent.quoted`,
`settlement.failed`, `settlement_intent.expired`. They exist in the schema and
nothing calls `Enqueue` for them, so subscribing to one means waiting forever.
Said plainly because the alternative is an integration that looks correct and
never fires; the payroll events above were wired into the enqueue path
specifically so as not to add a fifth.

## `payroll.run.*` payload

```json
{
  "type": "payroll.run.partial",
  "data": {
    "run_id": "pr_...",
    "status": "partial",
    "paid": 2,
    "failed": 1
  }
}
```

`paid` and `failed` are line counts, not currency groups. On a partial run,
`GET /v1/payroll_runs/{id}` names exactly who is in each.

## `settlement.succeeded` payload

```json
{
  "type": "settlement.succeeded",
  "created": 1786500000,
  "data": {
    "intent_id": "si_9x2LmQ",
    "tx_hash": "0x…",
    "status": "settled",
    "amount": "110990000",
    "settle_currency": "EUR",
    "payment_link_id": "pl_7Qk2mF",
    "merchant_reference": "table-14/bill-8871",
    "payer_reference": "diner-ref-1"
  }
}
```

| Field | Notes |
| --- | --- |
| `intent_id`, `tx_hash`, `status` | Always present. |
| `amount` | Integer **minor units**, as a string. Never a float. |
| `settle_currency` | ISO code (`EUR`), matching `settle_currency` everywhere else in the API. The token that actually moved is its stablecoin (`EURC`). |
| `payment_link_id` | Present only when the payment came from a payment link. |
| `merchant_reference` | Your own reference — the link's `merchant_reference`, copied onto the intent when it was paid. |
| `payer_reference` | The payer's reference, if they supplied one. |

`payment_link_id` and `merchant_reference` are what let a system match an event
back to what it was owed. A direct send has neither, and those keys are then
**absent rather than empty** — check for presence, not for `""`.

The last four fields are enrichment: if the lookup behind them fails, the event
is still delivered with the first three. A thin event beats a dropped one, so
treat `intent_id` as the only identifier guaranteed to be there.

Fields are added to payloads over time; ignore ones you don't recognise.
