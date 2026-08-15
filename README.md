# CONDUIT™

**Stablecoin settlement for businesses.**

A business chooses one currency to be paid in. Whoever pays them uses whatever stablecoin they already hold, on whatever chain they already hold it. Conversion, routing, and cross-chain funding happen in between, and the merchant receives what they asked for. Same-currency payments settle in about a second.

[App](https://useconduit-app.vercel.app) · [Docs](https://useconduit-app.vercel.app/docs) · Arc Testnet, chain ID 5042002

```
USDC ────────────────────────────────────────────────→ USDC     direct, ~1s on Arc
EURC → [StableFX] → USDC ────────────────────────────→ EURC     cross-currency
USDC on Solana → [Gateway] → USDC on Arc → [StableFX] → EURC     cross-chain
```

## This repository

The monorepo the product is built in.

```
packages/contracts/   Solidity (Foundry): ConduitRouter, AtomicSettler,
                      StableFXAdapter, DeclarationRegistry, SettlementPreferenceRegistry
packages/api/         Go settlement engine: accounts, payment links, settlement
                      intents, FX, cross-chain funding, webhooks. Postgres.
packages/app/         Next.js: landing, merchant dashboard, payer checkout, docs site
packages/sdk/         @conduit/sdk, browser and on-chain client
packages/node/        @conduit/node, server-side API client with webhook verification
docs/                 Source-of-truth markdown, rendered as the docs site
```

## What Conduit does

**Get paid in one currency.** A merchant sets their settle currency once. Every payment arrives in it, whatever the payer sent.

**Payment links and QR codes** with real lifecycle policy: fixed or open amounts, expiry, single-use or reusable, void. A storefront gets a printed QR that never expires.

**Pay from any chain.** A payer holding USDC on Solana, Base, Polygon, Ethereum, Avalanche, Optimism, Arbitrum, Unichain, Sonic, World Chain, Sei or HyperEVM can pay an invoice that settles on Arc. They pick where their money is; Conduit moves it.

**Drop-in checkout.** One script tag and `Conduit.checkout({...})`, with the merchant's server keeping control of the amount.

**An API and webhooks** for everything the dashboard can do, with `sk_`/`pk_` keys and HMAC-signed deliveries.

## Two surfaces, one engine

Conduit is a settlement engine with two front-ends that never share auth or state.

**Merchant** — authenticated and sticky. Sign in with Google, set a settle currency, issue links and QR codes, reconcile. This is `/dashboard`.

**Payer** — public and unauthenticated, the surface most people touch. Open a link or scan a QR, see the business name rather than a hex address, pay. No account. This is `/pay/[id]`.

The payer surface is deliberately never behind a sign-in. Keeping the two isolated is a product invariant, not an implementation detail.

## Authentication

Merchant login is Google, through Circle **user-controlled** wallets: MPC and non-custodial, so Conduit never holds a key. Circle is exposed to the app as an EIP-1193 provider behind a wagmi connector (`packages/app/src/lib/circle/`), which is what lets every wallet-reading component and every signing path work against it unchanged.

The Circle token is verified once, at login, and exchanged for a Conduit session token (`cs_`, HMAC-signed, 12 hours). Requests carry that rather than the provider's credential, so no identity provider sits on the request path.

`sk_`/`pk_` API keys remain the programmatic path. Google login is layered on top for humans, not a replacement.

## Settlement paths

| Path | Condition | Mechanism |
|---|---|---|
| Same-currency direct | payer token equals settle token, both on Arc | Conduit's own contracts, `ConduitRouter` → `AtomicSettler`, sub-second |
| Cross-currency | payer token differs from settle token | Circle StableFX RFQ: quote, trade, fund |
| Cross-chain | payer's USDC is on another chain | Circle Gateway deposit and burn intent, forwarder mints on Arc, then one of the paths above |

### What is Conduit's and what is Circle's

Same-currency payments move through Conduit's own on-chain contracts. That path is entirely ours.

Cross-currency does **not** put Conduit in custody and does not swap on-chain. Circle StableFX produces a signed quote off-chain, and Circle's maker delivers the settle currency to the recipient through a Permit2 transfer. Conduit orchestrates and signs on the payer's behalf after their authorising signature; the liquidity and the delivery are Circle's.

Cross-chain uses Circle Gateway, a deposit-then-spend model on CCTP rails rather than a bridge that burns per payment. The payer signs an off-chain burn intent and Circle's forwarder submits the mint on Arc. Conduit runs a `bridge_transfers` state machine with orphan recovery, so a process that dies mid-funding resumes rather than losing the transfer.

FX is quoted **after** funds land on Arc, never before, so a cross-chain payer is never quoted against liquidity that has not arrived.

Cross-currency and cross-chain payments are not atomic and are never presented as though they were. The payer sees real polled progress.

## Currency coverage

Conduit is USDC-hub: StableFX routes through USDC on one leg, so coverage is what quotes against USDC rather than a fixed list. Currently quotable:

| ISO | Token | Decimals |
|---|---|---|
| USD | USDC | 6 |
| EUR | EURC | 6 |
| BRL | BRLA | 18 |
| AUD | AUDF | 6 |
| MXN | MXNB | 6 |
| CAD | QCAD | 6 |
| GBP | GBPA | 6 |
| ZAR | ZARU | 18 |
| KRW | KRW1 | 18 |

`GET /v1/currencies` always reflects what is routable now. Token decimals differ; resolve them, never assume six.

## Network

| | |
|---|---|
| Network | Arc Testnet |
| Chain ID | 5042002 |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` |
| Gas token | USDC |

### Contracts

Deployed by Circle and Arc:

| Contract | Address |
|---|---|
| USDC | `0x3600000000000000000000000000000000000000` |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |
| StableFX FxEscrow | `0x867650F5eAe8df91445971f14d89fd84F0C9a9f8` |
| Gateway Wallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` |
| Gateway Minter | `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

Conduit's own contracts (`ConduitRouter`, `DeclarationRegistry`, `StableFXAdapter`, `AtomicSettler`, `SettlementPreferenceRegistry`) are deployed from `packages/contracts/script/Deploy.s.sol`. Addresses come from environment configuration and are never hardcoded.

## Running it

Requires pnpm 9+, Go 1.22+, Foundry, and Node 18+. Testnet USDC from [faucet.circle.com](https://faucet.circle.com).

```bash
pnpm install
```

API:

```bash
cd packages/api
# DATABASE_URL and STABLEFX_API_KEY required.
# CIRCLE_API_KEY enables Google login; ARC_RELAYER_KEY enables cross-chain.
go run ./cmd/api

# Or, with an embedded Postgres for local development:
go run ./cmd/devserver
```

App:

```bash
cd packages/app
cp .env.example .env.local   # API URL, contract addresses, Circle and Google client ids
pnpm dev
```

## API

| Area | Endpoints |
|---|---|
| Accounts | `POST /v1/accounts`, `GET /v1/accounts/me`, `PATCH /v1/accounts/:id` |
| Payment links | `POST/GET /v1/payment_links`, `POST /v1/payment_links/:id/void`, `GET /v1/payment_links/:id/public`, `POST /v1/payment_links/:id/pay` |
| Settlement intents | `POST/GET /v1/settlement_intents`, `.../quote`, `.../prepare`, `.../confirm`, `.../public` |
| Cross-chain | `POST /v1/settlement_intents/:id/bridge/initiate`, `GET .../bridge/status`, `GET .../bridge/plan` |
| Reference | `GET /v1/currencies`, `GET /v1/settlements`, `GET /v1/balance_transactions` |

Amounts are integer minor units everywhere, never floats. See [quickstart](docs/quickstart.md), [errors](docs/errors.md) and [webhooks](docs/webhooks.md).

```typescript
import { ConduitClient } from "@conduit/sdk";

const conduit = new ConduitClient({ signer });
await conduit.pay({ recipient: "0xRECIPIENT", amount: 10_000_000n, currency: "USDC" });
```

## Testing

Tests run against a real embedded Postgres, live Circle sandbox calls, and a real Arc fork. Nothing is mocked.

```bash
cd packages/api && go test ./...
cd packages/contracts && forge test --fork-url https://rpc.testnet.arc.network
```

`scripts/e2e.sh` runs a full settlement end to end against live services.

## Security

No secrets are committed; configuration is environment-driven. `AtomicSettler` uses a reentrancy guard and reverts fully rather than leaving partial state. Contracts are immutable in v1, with protocol parameters behind `Ownable` and intended for multisig on mainnet. Public payer endpoints are rate limited per client, and API keys are bearer tokens sent in a header, never implicitly. Set `CONDUIT_ALLOWED_ORIGINS` on any public deployment.

## License

Proprietary. Copyright © 2026 Conduit. All rights reserved. The source is publicly viewable for evaluation and reference only; no use, copy, modification, distribution, or deployment is permitted without written permission. See [LICENSE](LICENSE). Third-party components, including OpenZeppelin Contracts and forge-std under `packages/contracts/lib`, retain their own licenses.

---

CONDUIT™ · Arc Testnet · Chain ID 5042002
