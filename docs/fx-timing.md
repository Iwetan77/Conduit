# FX timing model

StableFX quotes are short-lived — Phase 0's capability probe measured **~3.5 seconds**
observed TTL (`docs/fx-capability.md`), not the 30–60 second window earlier planning
assumed. This resolves cleanly once you separate the two surfaces by when the rate is
locked in:

## Hosted checkout and QR — firm rate at payment time

The payer is at their wallet, present, about to sign. `quote → prepare → sign → submit`
all happen inside one short window with no exposure to anyone:

1. Payer picks a currency, sees a rate and a countdown.
2. They click pay. `/prepare` re-quotes fresh right then (never reuses the original
   `/quote` call's rate) and returns EIP-712 typed data.
3. Wallet signs. `/confirm` submits.
4. If the quote expires anywhere in that window: a clear, non-alarming re-quote prompt
   showing the new rate — never a silent retry with a stale number.

Nobody eats FX drift here. The rate you sign is the rate you get.

## Pre-priced invoices — indicative rate, disclosed buffer

An invoice sitting in an inbox for days, or a QR taped to a table for months, cannot carry
a firm quote — the payer isn't present. This is the one case that needs a buffer:
indicative rate at invoice-creation time, plus a disclosed spread, clearly labeled as an
estimate. The firm rate is still only ever set at the moment of actual payment
(same checkout flow as above) — the pre-priced number is guidance for the payer, not a
commitment either side is bound to.

## Indicative rates before anyone commits — `GET /v1/fx/rates`

Both surfaces above describe the *firm* rate, which by design only exists once the payer
is present and signing. That left a gap: a payer choosing what to pay with couldn't see
what they'd send until the wallet prompt was already open, and couldn't tell whether the
pair was routable or the amount large enough until it failed.

`GET /v1/fx/rates` closes it. Public, unauthenticated, and completely **stateless** — no
settlement intent, no `fx_trades` row, no status transition:

```bash
curl "https://conduit-z56x.onrender.com/v1/fx/rates?from=USDC&to=EURC&amount=5000000"
```

```json
{
  "from": "USDC", "to": "EURC",
  "amount": "5000000", "pay_amount": "5535500",
  "rate": "1.1071", "provider": "stablefx",
  "expires_at": 1786146540, "indicative": true
}
```

- `amount` is in minor units of `to` (the recipient's desired amount), matching how
  settlement intents are denominated. `pay_amount` is what the payer sends, in minor
  units of `from`.
- `from`/`to` accept either token symbols (`USDC`) or ISO codes (`USD`).
- Same-currency returns `provider: "direct"` at 1:1 without calling any provider.
- `indicative` is always `true`. **This is a display rate.** The firm rate is still the
  one `POST /settlement_intents/{id}/quote` returns at payment time.

It also answers the two questions that previously could only be discovered by failing:

| Case | Response |
|---|---|
| Pair has no route (neither side is USDC) | `fx_no_route` |
| Amount worth less than ~1.00 USD | `fx_invalid_amount` |

Both are real limits of the provider today — see [FX capability](./fx-capability.md) for
the measured pair matrix (only pairs with USDC on one leg quote) and the minimum.

## Why this matters for integrators

If you're building against `POST /:id/quote`, treat every quote as disposable the moment
you're not actively walking a payer through `/prepare` right after it. Don't cache a quote
and show it again later — request a fresh one. The API enforces this anyway
(`fx_quote_expired` on a stale `/prepare` call), but designing your UI around it up front
avoids a confusing "why did the amount change" moment for payers.
