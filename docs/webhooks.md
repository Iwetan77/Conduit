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

`settlement_intent.created`, `settlement_intent.quoted`, `settlement.succeeded`,
`settlement.failed`, `settlement_intent.expired`.

**Known gap as of this build:** only `settlement.succeeded` is actually enqueued anywhere
in the handler code today. The other four are defined in the schema/spec but nothing
calls `Enqueue` for them yet — don't rely on `settlement_intent.created` firing until this
is closed out.
