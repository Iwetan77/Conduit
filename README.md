# CONDUIT™

**Stablecoin settlement for businesses on Arc.**

Chain ID 5042002 · Arc Testnet

---

Conduit is a pipe. A payer sends in whatever stablecoin they hold; the merchant receives the currency they've chosen to settle in. FX conversion, route selection, and (when the payer's funds are on another chain) cross-chain funding happen in between. Same-currency payments on Arc settle in about a second; cross-currency and cross-chain payments take longer and the UI says so honestly — no "instant", no "atomic" claims on flows that aren't.

```
USDC ─────────────────────────────────────────────→ USDC        (direct, ~1s on Arc)
EURC → [StableFX RFQ] → USDC ──────────────────────→ EURC        (cross-currency FX)
USDC on Solana → [Circle Gateway] → USDC on Arc → [FX] → EURC     (cross-chain funding)
```

## Two surfaces, one settlement engine

Conduit is not one app. It's a settlement engine (`packages/api`) with two separate front-end surfaces that never share auth or state:

- **Merchant** — authenticated, sticky. A business signs in with Google (via **Circle Wallets**, which provisions a non-custodial MPC wallet), sets the currency it wants to receive once, and creates payment links and QR codes with real lifecycle policy (fixed/open amounts, expiry, single-use vs reusable, void). This is the dashboard (`/dashboard/*`).
- **Payer** — public, unauthenticated, the surface most people touch. Someone opens a link or scans a QR, sees the merchant's business name (not a bare hex address), and pays. No account, no jargon, mobile-first. This is `/pay/[id]`.

The dashboard requires a sign-in; the payer surface is deliberately **never** behind one. Keeping those two isolated is a hard product invariant.

### Merchant auth (Circle Wallets)

Human dashboard login is Google, through Circle **user-controlled** wallets — MPC, non-custodial, so Conduit never holds a key. Circle is exposed to the app as an EIP-1193 provider behind a wagmi connector (`packages/app/src/lib/circle/`), which is why every `useAccount()` call site and all eight signing paths work against it unchanged.

Server-side, the Circle user token is verified **once, at login**, and exchanged for a Conduit session token (`cs_`, HMAC-signed, 12h). Every subsequent request carries that instead of the provider's credential — re-verifying a provider token per request costs a network call to that provider, measured at 281ms to 7.6s on a polling dashboard.

The existing `sk_`/`pk_` API-key system stays as the machine/programmatic-access path; Google login is layered on top for humans, not a replacement.

This replaced Privy (removed 2026-08-14). Privy's free tier caps at 150 users and the next tier is $200/month; Circle's first 1,000 monthly active wallets are free.

## Settlement paths

| Path | Condition | Mechanism |
|---|---|---|
| Same-currency direct | payer token == settle token, both on Arc | On-chain via `ConduitRouter` / `AtomicSettler` — Conduit's own contracts, sub-second |
| Cross-currency FX | payer token != settle token | Circle **StableFX** RFQ + `/fund` — see below |
| Cross-chain funding | payer's USDC is on another chain (e.g. Solana) | Circle **Gateway** (Unified Balance Kit) deposit → burn intent → forwarder mint on Arc, then the FX/direct path above |

### What Conduit's contract does vs. what Circle does (the honest version)

For **same-currency direct** payments, Conduit's own on-chain contracts (`ConduitRouter` → `AtomicSettler`) move the funds. That path is fully Conduit's.

For **cross-currency FX**, Conduit does **not** hold custody or perform the swap itself. The real mechanism is Circle StableFX: an off-chain RFQ produces a signed quote, and Circle's maker delivers the settle-currency to the recipient via a Permit2 `permitWitnessTransferFrom` on `FxEscrow` (an ERC-1967 proxy that acts as the Permit2 spender — it has no `swap()` function). Conduit orchestrates and, for relayer-completed flows, signs on the payer's behalf after their single authorizing signature — but the FX liquidity and delivery are Circle's.

The real StableFX call sequence (`packages/api/internal/fx/stablefx.go`):

1. `POST /v1/exchange/stablefx/quotes` → quoteId + EIP-712 typed data
2. payer signs the quote typed data
3. `POST /v1/exchange/stablefx/trades` → contractTradeId
4. `POST /v1/exchange/stablefx/signatures/funding/presign` → funding typed data
5. payer signs the funding typed data
6. `POST /v1/exchange/stablefx/fund` → Circle executes and delivers to the recipient
7. poll `GET /v1/exchange/stablefx/trades/:id` until settled

FX quotes are ordered **after** funds have actually landed on Arc (quote-after-mint), never before — so a cross-chain payer isn't quoted against liquidity that hasn't arrived yet.

### Cross-chain funding (Circle Gateway / UBK)

When the payer's USDC is on another chain, Conduit uses Circle's **Gateway** (Unified Balance Kit) — a deposit-then-spend model on CCTP V2 rails, **not** a burn-per-payment bridge. The payer signs a **burn intent** (an off-chain signed message, ed25519 on Solana — not an on-chain transaction), and Circle's own forwarder relayer submits the destination-side mint on Arc automatically (Arc is a forwarder-supported destination). Conduit reuses a generalized `bridge_transfers` state machine with orphan-recovery: if the process dies mid-funding, a reconciler resumes exactly where a live session would have, because the burn is irreversible and the USDC will mint on Arc once attested.

The payer surface is **balance-aware**: Conduit reads the payer's real Gateway balance and shows "paying with USDC" as a confirmed fact when they hold enough — it never presents a static list of currencies the payer doesn't own.

See [`docs/ubk-capability.md`](docs/ubk-capability.md) for the byte-exact burn-intent encoding, the live-proven transaction hashes, and the deposit-then-spend mechanism.

## Currency coverage (the reality)

Conduit is **USDC-hub**: StableFX quotes route through USDC on one leg (hub-and-spoke), so coverage is "what quotes against USDC right now", not a static list. Live-probed against the current StableFX test key, these nine settle currencies quote successfully:

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

**JPY and PHP are not currently quotable on this key** (they return Circle error `3008 — invalid currency`). This is a key/coverage limitation to **re-probe**, not a permanent architectural dead end — the moment they quote against USDC they light up with no code change. `GET /v1/currencies` always reflects what's actually routable now; see [`docs/currencies.md`](docs/currencies.md) and [`docs/fx-capability.md`](docs/fx-capability.md) for the full live probe.

## Monorepo structure

```
conduit/
├── packages/
│   ├── contracts/   # Solidity (Foundry) — ConduitRouter, AtomicSettler, StableFXAdapter, DeclarationRegistry
│   ├── api/         # Go — the settlement engine: accounts, payment links, settlement intents,
│   │                #   StableFX FX, Circle Gateway funding, Circle auth, webhooks. Postgres.
│   ├── sdk/         # TypeScript — @conduit/sdk, for browsers and on-chain calls (bigint amounts, never number)
│   ├── node/        # TypeScript — @conduit/node, the server-side API client (webhook verification, typed calls)
│   └── app/         # Next.js — landing, merchant dashboard, payer checkout (/pay) and the docs site, in one app
├── docs/            # Source-of-truth markdown, rendered at /docs/guides by the app
└── package.json     # pnpm workspaces
```

## Network configuration

| Parameter | Value |
|---|---|
| Network | Arc Testnet |
| Chain ID | 5042002 |
| RPC | https://rpc.testnet.arc.network |
| WebSocket | wss://rpc.testnet.arc.network |
| Explorer | https://testnet.arcscan.app |
| Gas Token | USDC (18 decimals internally, 6 via ERC-20) |

## Contract addresses (Arc Testnet)

### Deployed by Circle / Arc (immutable)

| Contract | Address |
|---|---|
| USDC | `0x3600000000000000000000000000000000000000` |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |
| StableFX FxEscrow | `0x867650F5eAe8df91445971f14d89fd84F0C9a9f8` |
| Circle Gateway Wallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` |
| Circle Gateway Minter | `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| Gateway Domain (Arc) | `26` |

### Deployed by Conduit

`ConduitRouter`, `DeclarationRegistry`, `StableFXAdapter`, `AtomicSettler` — addresses come from `packages/contracts/script/Deploy.s.sol` output; set them in `packages/app/.env.local` and the API's environment. Never hardcoded.

## Getting started

### Prerequisites

- [pnpm](https://pnpm.io) v9+
- [Go](https://go.dev) 1.22+ (for the API)
- [Foundry](https://getfoundry.sh) (for contracts)
- Node.js 18+
- Testnet USDC from https://faucet.circle.com → Arc Testnet

### Install

```bash
git clone <repo>
cd conduit
pnpm install
```

### Run the API (settlement engine)

```bash
cd packages/api
# Requires: DATABASE_URL (Postgres), STABLEFX_API_KEY.
# Optional: ARC_RELAYER_KEY (enables cross-chain funding),
#           CIRCLE_API_KEY (enables merchant Google login via Circle Wallets).
go run ./cmd/api
# Or, for a self-contained embedded Postgres (local dev / e2e):
go run ./cmd/devserver
```

### Run the app (dashboard + payer surface)

```bash
cd packages/app
cp .env.example .env.local
# Set NEXT_PUBLIC_CONDUIT_API_URL, the deployed contract addresses,
# and NEXT_PUBLIC_CIRCLE_APP_ID + NEXT_PUBLIC_GOOGLE_CLIENT_ID (Google sign-in).
pnpm dev
```

## API surface (packages/api)

| Area | Endpoints |
|---|---|
| Accounts | `POST /v1/accounts`, `POST /v1/accounts/circle`, `GET /v1/accounts/me`, `PATCH /v1/accounts/:id` |
| Payment links | `POST/GET /v1/payment_links`, `GET /v1/payment_links/:id`, `POST /v1/payment_links/:id/void`, `GET /v1/payment_links/:id/public`, `POST /v1/payment_links/:id/pay` |
| Settlement intents | `POST/GET /v1/settlement_intents`, `GET /v1/settlement_intents/:id`, `.../quote`, `.../prepare`, `.../confirm`, `.../public` |
| Cross-chain funding | `POST /v1/settlement_intents/:id/bridge/initiate`, `GET .../bridge/status`, `GET .../bridge/balance` |
| Reference / ops | `GET /v1/currencies`, `GET /v1/settlements`, `GET /v1/balance_transactions`, webhooks |

Amounts are always integer minor units (bigint / Postgres `NUMERIC`), never floats. See [`docs/quickstart.md`](docs/quickstart.md), [`docs/errors.md`](docs/errors.md), and [`docs/webhooks.md`](docs/webhooks.md).

## SDK usage

```typescript
import { ConduitClient } from "@conduit/sdk";
import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider("https://rpc.testnet.arc.network");
const signer = new ethers.Wallet(PRIVATE_KEY, provider);
const conduit = new ConduitClient({ signer });

// Direct same-currency send (USDC → USDC), always bigint minor units
await conduit.pay({ recipient: "0xRECIPIENT", amount: 10_000_000n, currency: "USDC" });
```

**SDK rules:** all on-chain amounts are `bigint`, never `number`. Resolve each token's real decimals (USDC/EURC are 6; BRLA/ZARU/KRW1 are 18) — never assume 6.

## Testing

Go API tests run against a real embedded Postgres and real Circle sandbox calls — no mocks:

```bash
cd packages/api && go test ./... -short
```

Contract tests run against a real Arc Testnet fork:

```bash
cd packages/contracts && forge test --fork-url https://rpc.testnet.arc.network -vvv
```

## Security & honesty notes

- `AtomicSettler` uses `ReentrancyGuard` — full revert on failure, no partial states.
- Contracts are immutable in v1 (no upgradability); protocol params behind `Ownable`, intended for multisig on mainnet.
- The API's CORS defaults to a wildcard for local/testnet use. Set `CONDUIT_ALLOWED_ORIGINS` (comma-separated) on any public deployment; bearer tokens are sent in a header and credentials are never sent implicitly, but a deployment should still name its origins.
- Cross-currency and cross-chain flows are **not** atomic and are never described as such; the payer UI shows real, polled progress, not a timed animation.

---

*CONDUIT™ · Chain ID 5042002 · Arc Testnet*
