# Error codes

Every error response has the shape:

```json
{
  "error": {
    "type": "conduit_error",
    "code": "fx_quote_expired",
    "message": "The FX quote has expired. Request a new quote.",
    "param": "quote_id",
    "doc_url": "https://docs.conduit.xyz/errors/fx_quote_expired"
  }
}
```

`internal/errors/registry.go` is the single source of truth on the server side. No raw
contract revert string or upstream StableFX error body ever reaches a client — every
failure is translated through this registry first.

| Code | HTTP status | Meaning | What to do |
|---|---|---|---|
| `fx_quote_expired` | 409 | The quote you tried to `/prepare` against is past its `quote_expires_at`. | Request a fresh `/quote` — quotes are disposable, never cached (see [FX timing model](./fx-timing.md)). |
| `fx_no_route` | 422 | StableFX doesn't quote this currency pair. | Check `GET /v1/currencies` for what's actually routable right now — it reflects live StableFX coverage, not a static list. |
| `fx_invalid_amount` | 422 | The amount is outside StableFX's quotable range (too small or too large). | There's a real minimum notional (observed ~1 unit of a major currency on the sandbox) — don't assume any amount ≥ 1 minor unit is quotable. |
| `fx_provider_unavailable` | 503 | StableFX returned an error code this API doesn't have a specific mapping for. | Transient — retry with backoff. If it persists, it's worth a bug report since it means a new upstream error code needs mapping. |
| `currency_not_supported` | 422 | The currency isn't registered in `CurrencyRegistry` at all. | Check `GET /v1/currencies`. |
| `intent_expired` | 409 | The settlement intent's `expires_at` has passed. | Create a new intent. |
| `intent_already_settled` | 409 | You tried to quote/prepare/confirm/cancel an intent that's already `settled`. | Fetch the intent (`GET /v1/settlement_intents/:id`) — it already succeeded. |
| `idempotency_key_reuse` | 409 | You reused an `Idempotency-Key` with a request body that hashes differently from the first use. | Use a new key for a genuinely different request; reuse the same key only to safely retry the exact same request. |
| `signature_invalid` | 400 | The EIP-712 signature didn't verify against the expected signer/typed data. | Check you're signing the exact `typed_data`/`funding_typed_data` object the API returned, unmodified. |
| `insufficient_payer_balance` | 422 | The payer doesn't hold enough of the pay currency to fund this payment. | Nothing the API can do here — surface this to the payer directly. |
| `invalid_request` | 400 | Malformed request body or missing required field. | `param` on the error names the offending field. |
| `not_found` | 404 | The resource doesn't exist, or exists but isn't visible to this API key (wrong account, wrong livemode). | Double-check the ID and that your key's `livemode` matches. |
| `unauthorized` | 401 | Missing or invalid API key. | Check the `Authorization: Bearer` header. |
| `forbidden` | 403 | Your key is valid but isn't allowed to do this — e.g. a `pk_` key calling an `sk_`-only endpoint, or a cross-tenant `Conduit-Account` header. | Use the right key type / account. |
| `internal_error` | 500 | Something broke on our end. | Retry with backoff; if it persists, report it — this code intentionally carries no detail because a raw internal error should never leak to a client. |

## `rate_limited` (429)

The public payer routes are rate limited per client: **5 requests/second sustained,
burst 20**. Loading a pay page, polling its status, and requesting a quote sit
comfortably inside that; a script looping over a link URL does not.

The response carries `Retry-After: 1`. Back off and retry rather than tightening the
loop — the budget refills continuously, so a client that waits recovers within a second.

Authenticated routes (`sk_`/`pk_` keys, dashboard sessions) are not limited this way:
a key is already a credential and can be revoked.
