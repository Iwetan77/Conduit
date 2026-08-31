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
| `forbidden` | 403 | Your key is valid but isn't allowed to do this — e.g. a cross-tenant `Conduit-Account` header. | Use the right account. |
| `internal_error` | 500 | Something broke on our end. | Retry with backoff; if it persists, report it — this code intentionally carries no detail because a raw internal error should never leak to a client. |
| `settle_address_derived` | 400 | You sent `settle_address` on a request that derives it from the account. | Remove the field. Where a payment settles comes from the account that owns it — see [settlement addresses](settlement-addresses.md). Refused rather than ignored, so an integration cannot keep sending an address and keep being paid somewhere else. |
| `settlement_wallet_required` | 409 | This business has no settlement wallet of its own yet. | It is provisioned automatically on the next dashboard visit. Until then nothing is created, because the alternative is a link quietly paying into somebody's personal wallet. |
| `settlement_wallet_unknown` | 403 | The wallet id given does not belong to the signed-in Circle user. | Only a wallet Circle lists for that user can back a settlement address. Deliberately not a 404 — saying which ids exist would let a caller enumerate other people's wallets. |
| `settlement_wallet_invalid` | 422 | That wallet cannot be used for settlement — wrong chain, or it is the sign-in wallet. | Conduit settles on Arc, and the sign-in wallet is the thing being moved away from. |
| `settlement_wallet_already_set` | 409 | This account already has a settlement wallet. | Moving where income lands is a deliberate act with its own confirmation — see Advanced in [settlement addresses](settlement-addresses.md). |
| `payout_challenge_required` | 409 | You tried to verify a payout destination with no outstanding challenge. | Request one first: `POST /v1/payout_destinations/{id}/challenge`. |
| `payout_challenge_expired` | 409 | That challenge is no longer valid — expired, answered, or replaced. | Request a fresh one. Nonces are single-use, so an expired one cannot simply be signed again. |
| `payout_destination_unverified` | 409 | Nobody has proven control of that address. | Sign the challenge with the wallet at that address. An unproven address is indistinguishable from a typo, and the transfer is final. |
| `payout_not_found_on_chain` | 422 | The transaction given does not contain the transfer this payout describes. | Check the hash. A ledger built from what a client says happened is a ledger that can be told anything. |
| `confirmation_mismatch` | 400 | The confirmation text did not match the account name. | Type it exactly. This is friction rather than security — it exists so the change cannot happen by mis-clicking. |
| `upstream_unavailable` | 503 | A service this request depends on could not be reached. | Retry with backoff. Distinct from a definite refusal on purpose: retrying is right for one and not the other. |

## `rate_limited` (429)

The public payer routes are rate limited per client: **5 requests/second sustained,
burst 20**. Loading a pay page, polling its status, and requesting a quote sit
comfortably inside that; a script looping over a link URL does not.

The response carries `Retry-After: 1`. Back off and retry rather than tightening the
loop — the budget refills continuously, so a client that waits recovers within a second.

Authenticated routes (`sk_` keys, dashboard sessions) are limited separately, per account:
a key is already a credential and can be revoked.
