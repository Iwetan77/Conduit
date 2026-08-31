# Settlement addresses

Where your money lands, where you can send it, and why those are two different
questions.

## Your settlement wallet

Every business account gets an Arc wallet of its own, created for it through
Circle the first time you sign in. Payments to you land there.

It is **not** the wallet you sign in with. That distinction is the whole point.

Signing in with Google gives you a wallet — a personal one, yours, holding
whatever you already had. If your business settled to that, then business income
and your own money would arrive in the same place, and separating them
afterwards is bookkeeping nobody wants to do. So the account is given a second
wallet, and that is the one payments go to.

Both are yours. Circle's wallets are MPC and non-custodial: the key material is
derived on your device and Conduit never holds it. What Conduit holds is the
knowledge of *which* wallet is the settlement one.

You cannot type this address in, and there is nowhere to. It is created, not
chosen.

### Why you can't type one

Earlier versions asked. The field accepted anything that was twenty bytes of
well-formed hexadecimal — which includes an address on a different chain, an
exchange deposit address that will never credit an Arc token, a contract that
cannot receive, and every typo that happens to land in range. Settlement is
on-chain and final, so none of those are recoverable.

It also asked the question at the worst possible moment. Arc is new; almost
nobody signing up has a second Arc address to name, so the honest answer was
"the one you just gave me", and people pasted whatever they had.

## Payout destinations

An address you can **withdraw to**. Adding one does not route anything there —
money only moves when you ask.

A destination is unusable until you prove you control it. Conduit issues a
message, you sign it with the wallet at that address, and the signature is
checked server-side. Contract wallets — a Safe, or any multisig — are verified
through EIP-1271 instead, by asking the contract itself, because they hold no
key that could produce an ordinary signature.

The proof is not ceremony. Without it, an address that is yours and an address
that is a typo look identical, and you find out which by losing the money.

Withdrawing is two steps: Conduit authorises the transfer and your wallet signs
it. Nothing on the server can sign for you.

## Advanced: settling directly to an external address

If you would rather income landed in a treasury or a multisig without a
withdrawal step, Settings → Advanced will do that.

It can only point at a payout destination you have already verified. There is no
free-text address anywhere in this flow.

Two things worth understanding before you use it:

- Settlement is on-chain and final. Conduit cannot reverse one.
- Conduit holds no key for that address, so those funds will not be withdrawable
  from the dashboard. You move them with whatever controls the address.

It is reversible in one click. Switching away does not forget your Conduit
wallet — it stays yours, and switching back needs nothing from you but the click.

## What happens to links you have already made

Nothing.

A payment link or invoice records the address it settles to at the moment it is
created, and keeps it. Changing where your account settles does not move a
payment somebody has already been sent and may pay next week.

This is deliberate, and it is what makes the settings above safe to change: no
link ever has to be reissued, and nothing you have handed out quietly starts
paying somewhere else.

## For API callers

`settle_address` is derived from the account and is no longer accepted in
request bodies. Sending it is a `400 settle_address_derived` rather than being
ignored — an integration that kept sending an address and kept getting `201`
back would be paid somewhere other than it asked for, with nothing reporting a
problem.

- `POST /v1/settlement_intents`, `POST /v1/payment_links`, `POST /v1/accounts/sub`
  and `PATCH /v1/accounts/{id}` all take it from the owning account.
- `POST /v1/accounts` still supplies one. An API-key account has no Circle
  identity to provision a wallet from, so that address is recorded as
  `external`.
- Storefronts inherit their parent's address.

`GET /v1/accounts/me` reports `settle_address_source` — `provisioned`,
`login_wallet` or `external` — and `settlement_wallet_ready`.

Creating an intent or a link before a business has a settlement wallet answers
`409 settlement_wallet_required`. The alternative is a printed link quietly
paying into somebody's personal wallet.
