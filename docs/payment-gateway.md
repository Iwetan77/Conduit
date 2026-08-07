# Payment gateway

Accept stablecoins the way a merchant accepts cards: the buyer pays in whatever
stablecoin they hold, on whatever chain they hold it, and you receive a single
currency you chose. This is the drop-in, hosted-checkout side of Conduit — the
same settlement engine as the [Quickstart](./quickstart.md), wrapped so you
never write the quote → sign → confirm flow yourself. The buyer's wallet does
the signing inside the hosted checkout; your server only ever creates the charge
and listens for the result.

The model is deliberately the one you already know from Paystack/Stripe: your
**server** creates the charge with your secret key (so the amount is fixed and
the browser can't tamper with it), and the **browser** opens the returned
checkout. Your publishable key never has to create a charge.

## The pieces

| | |
|---|---|
| **API base** | `https://conduit-z56x.onrender.com` |
| **Checkout script** | `https://useconduit-app.vercel.app/conduit.js` |
| **Secret key** (`sk_…`) | Server-side only. Creates a charge. |
| **Publishable key** (`pk_…`) | Browser-safe. Can drive an existing charge (quote/prepare/confirm), never create one. |

## 1. Create the charge (your server, `sk_`)

A charge is a settlement intent. Fix the amount and the currency **you** want to
be paid in — the buyer's currency is their choice, made at checkout.

```bash
curl -s -X POST https://conduit-z56x.onrender.com/v1/settlement_intents \
  -H "Authorization: Bearer $CONDUIT_SECRET_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H 'content-type: application/json' \
  -d '{
    "amount": 7000000,
    "settle_currency": "USD",
    "settle_address": "0xYourMerchantWallet",
    "reference": "order_1481",
    "metadata": { "order_id": "1481" }
  }'
```

`amount` is always in **minor units** (integer, never a float): `7000000` = 7.00
USD at USDC's 6 decimals. See [Currencies](./currencies.md) for each currency's
decimals.

The response carries what the browser needs:

```json
{
  "id": "si_…",
  "status": "created",
  "hosted_url": "https://useconduit-app.vercel.app/pay/si_…",
  "qr_payload": "si_…",
  "amount": "7000000",
  "settle_currency": "USD",
  "settle_address": "0xYourMerchantWallet"
}
```

Return `hosted_url` (and, if you want a QR, `id`) to your page. Never return your
secret key.

## 2a. Inline popup (same device)

Drop the script in, hand it the `hosted_url`, and Conduit opens the checkout in a
modal iframe over your page. Callbacks fire when the buyer settles or dismisses.

```html
<script src="https://useconduit-app.vercel.app/conduit.js"></script>
<script>
  async function pay() {
    // Your endpoint calls step 1 with your secret key and returns hosted_url.
    const res = await fetch("/api/checkout", { method: "POST" });
    const { hosted_url } = await res.json();

    Conduit.checkout({
      url: hosted_url,
      onSuccess: function (r) {          // r.intent = "si_…"
        window.location = "/thank-you?ref=" + r.intent;
      },
      onClose: function () {},           // buyer dismissed the popup
    });
  }
</script>
```

`Conduit.checkout(opts)` accepts:

- `url` — the `hosted_url` your server received. **Required.**
- `onSuccess(r)` — called once the payment settles; `r.intent` is the intent id.
- `onClose()` — called if the buyer dismisses the popup without paying.
- `onLoad(r)` — optional; the checkout finished loading.

The iframe and the script talk over `postMessage` scoped strictly to the
checkout's own origin, so a page embedding the script can't forge a `settled`.
`onSuccess` is a UX convenience — treat the **webhook** (below) as the source of
truth before you release goods.

## 2b. Scan to pay (buyer's phone)

For a POS or desktop checkout, render a QR of the `hosted_url` (or of the
`qr_payload`, which is the bare intent id) and let the buyer pay on their phone.
Since that's a different device, you can't hear the `postMessage` — poll the
charge's public status instead:

```
GET https://conduit-z56x.onrender.com/v1/settlement_intents/{id}/public
→ { "status": "created" | "settled" | … }
```

Poll every few seconds until `status` is `settled`, then advance your UI. This
endpoint is public and read-only: it exposes only amount, currency, status,
expiry, and the merchant's display identity — never your keys, reference, or
metadata.

## 3. Confirm server-side with a webhook

The authoritative signal that money landed is the `settlement.succeeded`
webhook. Register an endpoint (dashboard or `POST /v1/webhook_endpoints`) and
verify every delivery — see [Webhook verification](./webhooks.md) for the HMAC
check in Node, Go, and Python.

```json
{
  "type": "settlement.succeeded",
  "data": { "intent_id": "si_…", "tx_hash": "0x…", "status": "settled" }
}
```

`tx_hash` is a real Arc testnet transaction, verifiable on
[ArcScan](https://testnet.arcscan.app). Match `intent_id` back to your order and
fulfil.

## What the buyer can pay with

The buyer chooses their currency at checkout — the hosted page handles every
route so you don't have to:

- **Same currency** (e.g. you settle USD, they hold USDC): settles straight
  on-chain in the buyer's wallet, sub-second, no FX.
- **Cross-currency** (they hold EURC, you settle USD): routed through Circle
  StableFX — a firm rate at payment time, two wallet signatures. See
  [FX timing](./fx-timing.md).
- **Cross-chain** (they hold USDC on Solana, Base, Polygon, and 9 more): bridged
  in via Circle Gateway, then settled to you on Arc. See
  [CCTP capability](./cctp-capability.md). The buyer needs no Arc wallet.

In every case you receive exactly `amount` in `settle_currency` at
`settle_address`, and get one `settlement.succeeded` webhook.

## Integration checklist

- [ ] Create charges **only** on your server, with your `sk_` key.
- [ ] Amounts in integer minor units, never floats.
- [ ] Use an `Idempotency-Key` on charge creation so a retried request never
      double-creates.
- [ ] Return only `hosted_url` / `id` to the browser — never a secret key.
- [ ] Treat the `settlement.succeeded` webhook (verified) as the source of
      truth; `onSuccess` / status polling are UX.

## Anyone can integrate

This is not merchants-only. Any platform — a marketplace, a SaaS, a creator
tool, an on-chain app — can wire the same three steps to accept every stablecoin
across chains and settle in one currency, with no card rails and no FX desk.
```
