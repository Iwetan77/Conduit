# Payment links

A payment link is a **policy layer** on top of a settlement intent. The link itself never
moves money — every successful payment against a link creates a `settlement_intent`
(the unchanged quote → prepare → confirm flow), tagged back to the link via
`payment_link_id`. What the link adds is merchant policy: how the amount is chosen,
when the link stops working, and whether it can be paid more than once.

All amounts are **integer minor units** (strings over the wire, `NUMERIC(78,0)` in
Postgres) — never floats.

## Creating a link

```bash
curl -s -X POST "$API/v1/payment_links" \
  -H "Authorization: Bearer $SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "amount_mode": "fixed",
    "amount": "25000000",
    "settle_currency": "EURC",
    "settle_address": "0xYourSettleAddress",
    "reuse_policy": "single_use",
    "expires_at": "2026-08-31T00:00:00Z",
    "description": "Invoice #1042",
    "merchant_reference": "INV-1042"
  }'
```

The response includes `hosted_url` (`/pay/:id` on the app) — that URL and its QR code
are the public payer surface. The payer never authenticates.

### Amount modes

| `amount_mode` | `amount` | `min_amount` / `max_amount` | Payer experience |
|---|---|---|---|
| `fixed` | required | — | Amount is locked; payer's submitted amount is ignored |
| `open` | must be omitted | optional bounds | Payer must enter an amount (`payment_link_amount_required` otherwise) |
| `open_with_suggested` | required (the suggestion) | optional bounds | Field pre-filled with the suggestion; payer may override within bounds |

For `open` and `open_with_suggested`, a payer-supplied amount outside
`[min_amount, max_amount]` is rejected with `payment_link_amount_out_of_bounds` (HTTP 422).

### Reuse policy

- `single_use` (default) — exactly one successful payment. The claim is an **atomic
  `UPDATE … WHERE status IN ('active','viewed')`** at pay time, so two concurrent payers
  cannot both pay: the loser gets `payment_link_already_used` (HTTP 409). The link then
  follows its settlement intent to `paid` → `settled`.
- `multi_use` — a standing link/QR (tip jar, donation, price list). It can generate many
  settlement intents and stays `active`/`viewed` indefinitely; it never reaches
  `paid`/`settled` itself.

## Lifecycle

```
draft → active → viewed → paid → settled
              ↘ expired (expires_at passed)
              ↘ void    (merchant action)
```

- `viewed` is set the first time the public endpoint is fetched — the merchant can see
  a link has been opened before it's paid.
- `expired` is enforced **server-side at pay time**, not just hidden in the UI: paying an
  expired link returns `payment_link_expired` (HTTP 409) regardless of what any client
  shows. The public fetch also lazily flips the stored status once `expires_at` passes.
- `void` — `POST /v1/payment_links/:id/void` (authenticated). Voiding is idempotent;
  a link that is already `paid`/`settled` cannot be voided (`payment_link_already_used`).
  Paying a voided link returns `payment_link_voided` (HTTP 409).

`paid`/`settled` are terminal for `single_use` links only (see reuse policy above).

## Paying a link

The payer flow is unauthenticated end to end:

1. `GET /v1/payment_links/:id/public` — link policy plus the merchant's identity
   (`display_name`, `logo_url`, `settle_address`), so the payer sees a business name,
   not a bare hex address.
2. `POST /v1/payment_links/:id/pay` — body `{ "amount": "...", "payer_reference": "..." }`
   (empty body is valid for `fixed` links). All policy is enforced here with typed errors.
   On success it returns the created settlement intent.
3. The payer continues through the normal settlement flow (`quote` → `prepare` →
   `confirm`) exactly as for a bare settlement intent.

`payer_reference` is the **payer's own** reconciliation field (their PO number), stored
on the settlement intent — distinct from the merchant's `merchant_reference` on the
link. Two-sided reconciliation: each side keeps its own reference.

### Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `payment_link_expired` | 409 | `expires_at` has passed |
| `payment_link_voided` | 409 | Merchant voided the link |
| `payment_link_already_used` | 409 | Single-use link already paid (or void attempted on a paid link) |
| `payment_link_amount_out_of_bounds` | 422 | Amount outside `[min_amount, max_amount]` |
| `payment_link_amount_required` | 400 | `open` link paid without an amount |

See [errors](/guides/errors) for the full registry.

## Funding status (cross-chain payers)

When the payer's USDC lives on another chain (e.g. Solana), the settlement intent
created by `pay` goes through a **funding pre-stage** on Circle Gateway before the
normal FX/direct path. Three endpoints, all under the intent:

- `GET /v1/settlement_intents/:id/bridge/balance?payer_address=...` — the payer's real
  unified Gateway balance, broken down `by_chain` (`solana`, `arc`, `sui`). The payer UI
  is balance-aware: it shows what the payer actually holds, never a static currency list.
- `POST /v1/settlement_intents/:id/bridge/initiate` — begins the deposit → burn-intent →
  forwarder-mint sequence (the burn intent is an off-chain signed message; Circle's
  forwarder submits the Arc mint).
- `GET /v1/settlement_intents/:id/bridge/status` — polled, real progress through the
  `bridge_transfers` state machine. If the API crashes mid-funding, a reconciler resumes
  the transfer — the burn is irreversible, so the mint is recovered, never dropped.

FX quotes are ordered **after** the funds land on Arc (quote-after-mint), so a
cross-chain payer is never quoted against liquidity that hasn't arrived.

See [state diagrams](/guides/state-diagrams) for the intent lifecycle this nests into,
and `docs/ubk-capability.md` in the repo for the byte-exact Gateway encoding and live
transaction hashes.
