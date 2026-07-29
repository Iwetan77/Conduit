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

## Why this matters for integrators

If you're building against `POST /:id/quote`, treat every quote as disposable the moment
you're not actively walking a payer through `/prepare` right after it. Don't cache a quote
and show it again later — request a fresh one. The API enforces this anyway
(`fx_quote_expired` on a stale `/prepare` call), but designing your UI around it up front
avoids a confusing "why did the amount change" moment for payers.
