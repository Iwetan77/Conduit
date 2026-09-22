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
    "settle_currency": "EUR",
    "reuse_policy": "single_use",
    "expires_in": 3600,
    "description": "Invoice #1042",
    "merchant_reference": "INV-1042"
  }'
```

`settle_currency` is an **ISO currency code** (`EUR`, `USD`, …), not a token symbol.
`expires_in` is the link's lifetime in **seconds** (omit or `0` for a non-expiring
link); the response returns the resolved `expires_at` timestamp.

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

- `single_use` (default) — exactly one successful payment. Paying does **not** mark the
  link paid: checkout instead stakes a **reservation** (with an expiry matching the
  intent's own `expires_at`). A second checkout while the first is in flight is refused
  with `payment_link_in_checkout` (HTTP 409). The link flips to `paid` only when the
  intent's settlement actually lands, so an abandoned or failed checkout releases the
  reservation (on its own at expiry, or immediately when the intent is cancelled) and
  leaves the link payable rather than falsely marking it paid.
- `multi_use` — a standing link/QR (tip jar, donation, price list). It can generate many
  settlement intents concurrently and returns to `active` after each settlement; it never
  reaches `paid` itself.

## Lifecycle

```
active → viewed → paid       (single_use only; paid is terminal)
        ↘ expired             (expires_in passed)
        ↘ void                (merchant action)
```

- Links are created `active`.
- `viewed` is set the first time the public endpoint is fetched — the merchant can see
  a link has been opened before it's paid.
- `paid` is set **only when a settlement lands** (never at checkout start), and only for
  `single_use` links. There is no separate `settled` state for a link — the settlement
  itself is what moves a single-use link to `paid`.
- `expired` is enforced **server-side at pay time**, not just hidden in the UI: paying an
  expired link returns `payment_link_expired` (HTTP 409) regardless of what any client
  shows. The public fetch also lazily flips the stored status once `expires_at` passes.
- `void` — `POST /v1/payment_links/:id/void` (authenticated). Voiding is idempotent;
  a link that is already `paid` cannot be voided (`payment_link_already_used`).
  Paying a voided link returns `payment_link_voided` (HTTP 409).

## Paying a link

The payer flow is unauthenticated end to end:

1. `GET /v1/payment_links/:id/public` — link policy plus the merchant's identity
   (`display_name`, `logo_url`, and the address it settles to), so the payer sees a business name,
   not a bare hex address.
2. `POST /v1/payment_links/:id/pay` — body `{ "amount": "...", "payer_reference": "..." }`
   (empty body is valid for `fixed` links). All policy is enforced here with typed errors.
   On success it returns the created settlement intent and, for a `single_use` link,
   reserves the link for that intent (see reuse policy).
3. The payer continues through the normal settlement flow — a direct same-currency pay
   (`record`), StableFX (`quote` → `prepare` → `confirm`), or the client-side Circle
   Gateway bridge (`bridge/plan` → `bridge/report_spend`) — exactly as for a bare
   settlement intent.

`payer_reference` is the **payer's own** reconciliation field (their PO number), stored
on the settlement intent — distinct from the merchant's `merchant_reference` on the
link. Two-sided reconciliation: each side keeps its own reference.

### Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `payment_link_expired` | 409 | `expires_at` has passed |
| `payment_link_voided` | 409 | Merchant voided the link |
| `payment_link_already_used` | 409 | Single-use link already paid (or void attempted on a paid link) |
| `payment_link_in_checkout` | 409 | Single-use link already reserved by an in-flight checkout |
| `payment_link_amount_out_of_bounds` | 422 | Amount outside `[min_amount, max_amount]` |
| `payment_link_amount_required` | 400 | `open` link paid without an amount |

See [errors](/guides/errors) for the full registry.

## Funding status (cross-chain payers)

When the payer's USDC lives on another chain (e.g. Solana), the settlement intent
created by `pay` is funded through Circle's **Unified Balance Kit (UBK)**. The browser
drives Circle's SDK directly; Conduit only tells it where to mint and how much to spend,
then polls the resulting mint and runs the normal settlement handoff. All endpoints sit
under the intent:

- `GET /v1/settlement_intents/:id/bridge/balance?payer_address=...` — the payer's real
  unified Gateway balance, broken down `by_chain` (`solana`, `arc`, `base`, …). The payer
  UI is balance-aware: it shows what the payer actually holds, never a static currency list.
- `GET /v1/settlement_intents/:id/bridge/plan` — answers "if I pay with USDC from another
  chain, where does it go and how much USDC do I need?" The client then performs the
  deposit + burn-intent signing itself, and Circle mints the USDC to Conduit's Arc relayer.
- `POST /v1/settlement_intents/:id/bridge/report_spend` — the client reports the resulting
  Gateway transfer id (plus `source_chain` and the `usdc_amount` actually spent). Conduit
  records a `bridge_transfers` row and, in the background, polls the mint and hands off to
  the existing quote → prepare → confirm settlement.
- `GET /v1/settlement_intents/:id/bridge/status` — polled, real progress through the
  `bridge_transfers` state machine. If the API crashes mid-funding, a reconciler resumes
  the transfer — the burn is irreversible, so the mint is recovered, never dropped.

FX quotes are ordered **after** the funds land on Arc (quote-after-mint), so a
cross-chain payer is never quoted against liquidity that hasn't arrived.

See [state diagrams](/guides/state-diagrams) for the intent lifecycle this nests into,
and `docs/ubk-capability.md` in the repo for the byte-exact Gateway encoding and live
transaction hashes.
