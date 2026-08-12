# Point of sale: a QR per bill

A storefront supports two different counters, and they need different QR codes.

**A fixed QR, printed once.** A market stall, a cafe counter, a taxi, a salon
chair. One sticker, and the customer types what they owe. Create the storefront
in the dashboard, download its QR, laminate it, done — no code involved.

**A QR per bill, printed by the till.** A restaurant. The total isn't known
until the kitchen closes the tab, so the QR has to carry `110.99` and nothing
else. That means the point-of-sale calls Conduit when it prints the bill and
renders the returned URL as a QR on the receipt.

This guide is the second one. It is an API integration, not a dashboard
feature — the dashboard isn't standing at the pass when the fish comes up.

Both use the same primitive: a payment link bound to a storefront. The fixed
sticker is an open-amount link; a bill is a fixed-amount one.

---

## 1. Get the storefront's key

Every storefront has its own secret key. Use it — not the parent account's. A
link created with the parent's key lands on the parent's books, and you lose the
per-location attribution that is the whole reason storefronts exist. A
per-storefront key also means a compromised till burns one location, not the
business.

Dashboard → **Storefronts** → the card → **Create API key for a till**.

The secret appears once. If you lose it, mint another from the same button and
revoke the old one after the new one is deployed:

```
POST /v1/api_keys/{key_id}/revoke
```

Rotation is deliberately two steps. A single atomic "rotate" would kill the
running till's credential the instant someone clicked a button in a dashboard.

---

## 2. Create a link when the bill prints

One call per bill. `amount` is in **integer minor units** — never a float.
`110.99` in a 6-decimal currency is `110990000`.

```bash
curl -X POST https://api.example.com/v1/payment_links \
  -H "Authorization: Bearer sk_test_<storefront key>" \
  -H "Content-Type: application/json" \
  -d '{
    "amount_mode": "fixed",
    "amount": "110990000",
    "settle_currency": "EUR",
    "settle_address": "0x...storefront settle address",
    "reuse_policy": "single_use",
    "merchant_reference": "table-14/bill-8871",
    "expires_in": 3600
  }'
```

```json
{
  "id": "pl_7Qk2mF",
  "amount_mode": "fixed",
  "amount": "110990000",
  "status": "active",
  "hosted_url": "https://app.example.com/pay/pl_7Qk2mF"
}
```

Notes that matter in a restaurant:

- **`single_use`** — a bill is paid once. The link closes as soon as a real
  settlement lands, so a photographed receipt can't be paid twice.
- **`expires_in`** — an hour is generous for a table. An expired link is
  rejected rather than silently accepted at a stale price.
- **`merchant_reference`** — your bill number. This is what you reconcile
  against later; put the table and bill id in it.
- **`settle_currency`** is the currency you keep books in. The customer can pay
  in any supported stablecoin from any supported chain; conversion is Conduit's
  problem, not the till's.

## 3. Print `hosted_url` as the QR

Encode the `hosted_url` string — not the link id, and never a wallet address.
Most receipt printers (ESC/POS) can render a QR natively:

```
GS ( k  ...  <hosted_url>
```

If yours can't, generate a PNG and print it as a bitmap. Keep it at least
~2cm square at 300dpi; diners scan it in bad light at arm's length.

Print the amount in human digits next to it. The QR is a convenience, not a
receipt.

## 4. Know when it's paid

Poll the link until it closes. For a till this is simpler and more robust than
a webhook — the terminal already has a "waiting for payment" screen open, and
polling needs no public endpoint on the restaurant's network.

```bash
curl https://api.example.com/v1/payment_links/pl_7Qk2mF \
  -H "Authorization: Bearer sk_test_<storefront key>"
```

`status` moves `active` → `viewed` (customer opened it) → `paid` (money actually
landed). Only `paid` means paid. `viewed` means someone scanned it, which is not
the same thing and must never open the cash drawer.

Every couple of seconds is plenty; a settlement is not instant.

**Webhooks**: `settlement.succeeded` also fires, but its payload currently
carries `intent_id` and not the `payment_link_id` or your
`merchant_reference` — so a till can't map it back to a bill without an extra
lookup. Poll for now.

## 5. Reconcile

The storefront's settlements are its own. `GET /v1/settlements` with the
storefront's key returns only that location's takings, with your
`merchant_reference` on each row — so the till's bill numbers line up with what
landed, per location, without any manual splitting.

---

## What not to do

- **Don't print the storefront's settle address.** It works — money sent to it
  arrives on-chain — but it bypasses Conduit completely: no conversion into your
  currency, no settlement row, no attribution. It looks to everyone like a
  payment that succeeded and simply isn't in your books.
- **Don't reuse one fixed-amount link across bills.** It closes on the first
  payment, by design.
- **Don't compute amounts as floats.** `110.99 * 1e6` is not reliably
  `110990000` in most languages. Do integer arithmetic on minor units.
