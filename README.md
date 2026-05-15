# CONDUIT™
**Arc's Native Agent Payment Protocol**

Chain ID 5042002 · Arc Testnet · May 2026

---

Conduit is a pipe. Money goes in one end in whatever currency the sender holds. It comes out the other end in whatever currency the recipient specified. Everything in the middle — FX conversion, route selection, bridging, atomic settlement — happens automatically in under a second.

```
USDC ──────────────────────────────────────────────→ USDC
EURC → [StableFX RFQ] → USDC → [ConduitRouter] → USDC
USDC → [StableFX RFQ] → EURC → [ConduitRouter] → EURC
```

## Architecture

One underlying primitive: a **payment declaration**. Everything Conduit ships is either a way to create a declaration or a way to fulfill one.

**Four entry points. One contract underneath.**

| Entry Point | Description | Declaration? |
|---|---|---|
| Direct Send | Paste address → pick amount → send | No |
| Payment Link | Recipient creates declaration → shareable URL | Yes |
| QR Code | Same declaration → print-ready branded QR | Yes |
| SDK | `conduit.pay()` for developers and agents | Optional |

## Monorepo Structure

```
conduit/
├── packages/
│   ├── contracts/          # Solidity — Foundry
│   │   ├── src/
│   │   │   ├── interfaces/
│   │   │   │   ├── IFxEscrow.sol           # Circle StableFX interface
│   │   │   │   ├── ICCTPTokenMessenger.sol # CCTP v2 interface
│   │   │   │   └── IConduitRouter.sol      # Router interface
│   │   │   ├── DeclarationRegistry.sol     # Standalone payment declarations
│   │   │   ├── StableFXAdapter.sol         # FxEscrow wrapper + Permit2
│   │   │   ├── CCTPAdapter.sol             # CCTP v2 cross-chain wrapper
│   │   │   ├── AtomicSettler.sol           # ReentrancyGuard settlement engine
│   │   │   └── ConduitRouter.sol           # Single execution surface
│   │   ├── test/                           # Forge tests (Arc testnet fork)
│   │   └── script/Deploy.s.sol             # Deployment script
│   │
│   ├── sdk/                # TypeScript — @conduit/sdk
│   │   └── src/
│   │       ├── types.ts        # All types (bigint amounts, no number)
│   │       ├── constants.ts    # Arc testnet addresses + ABIs
│   │       ├── declaration.ts  # DeclarationRegistry client
│   │       ├── router.ts       # ConduitRouter client
│   │       ├── receipt.ts      # Event-sourced receipt history
│   │       ├── client.ts       # ConduitClient — main public API
│   │       └── index.ts        # Public exports
│   │
│   ├── app/                # Next.js 14 App Router — app.conduit.xyz
│   │   └── src/
│   │       ├── app/
│   │       │   ├── page.tsx              # / — Direct Send (default)
│   │       │   ├── create/page.tsx       # /create — Link + QR outputs
│   │       │   ├── pay/[id]/page.tsx     # /pay/[id] — Public payment page
│   │       │   ├── links/page.tsx        # /links — Manage declarations
│   │       │   ├── history/page.tsx      # /history — Transaction history
│   │       │   └── agent/page.tsx        # /agent — Agent wallet config
│   │       └── components/
│   │           ├── SendFlow/             # Direct send components
│   │           ├── CreateFlow/           # Link + QR creation
│   │           │   ├── LinkOutput/       # Digital sharing card
│   │           │   └── QROutput/         # Physical QR display
│   │           ├── PayFlow/              # Payment fulfillment
│   │           └── Shared/               # Nav, Logo, WalletConnect, etc.
│   │
│   └── marketing/          # Next.js 14 static — conduit.xyz
│
├── package.json            # pnpm workspaces
└── turbo.json
```

## Network Configuration

| Parameter | Value |
|---|---|
| Network | Arc Testnet |
| Chain ID | 5042002 |
| RPC | https://rpc.testnet.arc.network |
| WebSocket | wss://rpc.testnet.arc.network |
| Explorer | https://testnet.arcscan.app |
| Gas Token | USDC (18 decimals internally, 6 via ERC-20) |

## Contract Addresses (Arc Testnet)

### Deployed by Circle / Arc (Immutable)

| Contract | Address |
|---|---|
| USDC | `0x3600000000000000000000000000000000000000` |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |
| StableFX FxEscrow | `0x867650F5eAe8df91445971f14d89fd84F0C9a9f8` |
| CCTP TokenMessengerV2 | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| CCTP MessageTransmitterV2 | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| CCTP TokenMinterV2 | `0xb43db544E2c27092c107639Ad201b3dEfAbcF192` |
| CCTP Domain (Arc) | `26` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| Gateway GatewayWallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` |
| Gateway GatewayMinter | `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| CREATE2 Factory | `0x4e59b44847b379578588920cA78FbF26c0B4956C` |

### Deployed by Conduit (Fill after `Deploy.s.sol`)

| Contract | Address |
|---|---|
| ConduitRouter | *(deploy first)* |
| DeclarationRegistry | *(deploy first)* |
| StableFXAdapter | *(deploy first)* |
| AtomicSettler | *(deploy first)* |
| CCTPAdapter | *(deploy first)* |

## Getting Started

### Prerequisites

- [pnpm](https://pnpm.io) v9+
- [Foundry](https://getfoundry.sh) (for contracts)
- Node.js 18+
- Testnet USDC from https://faucet.circle.com → Arc Testnet

### Install

```bash
git clone <repo>
cd conduit
pnpm install
```

### Deploy Contracts

```bash
cd packages/contracts

# Install Foundry dependencies
forge install OpenZeppelin/openzeppelin-contracts
forge install foundry-rs/forge-std

# Configure environment
cp .env.example .env
# Set PRIVATE_KEY in .env (wallet with testnet USDC for gas)

# Build
forge build

# Test (against Arc testnet fork — real state, no mocks)
forge test --fork-url https://rpc.testnet.arc.network -vvv

# Deploy to Arc Testnet
forge script script/Deploy.s.sol --rpc-url https://rpc.testnet.arc.network --broadcast --slow

# Output will show all deployed addresses — copy to packages/app/.env.local
```

### Configure App

```bash
cd packages/app
cp .env.example .env.local
# Fill in the deployed contract addresses from Deploy.s.sol output
# Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID (get from cloud.walletconnect.com)
```

### Run App

```bash
pnpm app          # Start Next.js app on :3000
# or
cd packages/app && pnpm dev
```

### Build SDK

```bash
cd packages/sdk
pnpm build        # Outputs to dist/
```

## SDK Usage

```typescript
import { ConduitClient } from "@conduit/sdk";
import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider("https://rpc.testnet.arc.network");
const signer = new ethers.Wallet(PRIVATE_KEY, provider);
const conduit = new ConduitClient({ signer, network: "arc-testnet" });

// ── Direct Send (USDC → USDC) ──────────────────────────────────────────────
await conduit.pay({
  recipient: "0xRECIPIENT_ADDRESS",
  amount: 10_000_000n,   // $10 USDC — always bigint, always 6 decimals
  currency: "USDC",
});

// ── Create Payment Link ────────────────────────────────────────────────────
const { declarationId, paymentUrl } = await conduit.createLink({
  amount: 0n,            // 0 = open amount (pay what you want)
  currency: "EURC",
  label: "Table 7",
});
// → https://app.conduit.xyz/pay/0xABC...

// ── Parse & Fulfill a Declaration ─────────────────────────────────────────
const declaration = await conduit.parse(paymentUrl);
await conduit.fulfill(declaration, { payerToken: "USDC" });

// ── Deactivate a Link ──────────────────────────────────────────────────────
await conduit.deactivateLink(declarationId);

// ── Quote ──────────────────────────────────────────────────────────────────
const q = await conduit.quote({
  payerToken: "EURC",
  recipientToken: "USDC",
  amount: 10_000_000n,
});

// ── History ────────────────────────────────────────────────────────────────
const receipts = await conduit.getHistory("0xWALLET", { limit: 20 });
```

**Critical SDK Rules:**
- All on-chain amounts use `bigint`. Never `number`.
- USDC and EURC: always 6-decimal ERC-20 values. Never 18-decimal native gas values.

## Brand System

| Token | Value |
|---|---|
| Background | `#000000` |
| Green | `#B2F55A` — exact brand color |
| White | `#FFFFFF` |
| Dark Surface | `#111111` |
| Border | `#1F1F1F` |
| Muted Text | `#666666` |
| Display Font | Barlow Condensed 700/800/900 |
| Body Font | Barlow 400/500/600 |
| Mono Font | IBM Plex Mono 400/500 |

Wordmark: **CON** in `#B2F55A` + **DUIT** in `#FFFFFF`
Logomark: Circle-pipe-D symbol (see `components/Shared/Logo.tsx`)

## Contracts — Technical Notes

### Payment Instruction

```solidity
struct PaymentInstruction {
    address payer;
    address recipient;
    address payerToken;       // ERC-20 address — 6-decimal units ONLY
    address recipientToken;
    uint256 amount;           // in recipientToken units (6 decimals)
    uint256 deadline;         // unix timestamp
    bytes32 declarationId;    // bytes32(0) for direct sends
}
```

### Settlement Paths

| Path | Condition | Mechanism |
|---|---|---|
| Same-currency direct | `payerToken == recipientToken` | `AtomicSettler.settleDirect()` |
| Cross-currency FX | `payerToken != recipientToken` | `AtomicSettler.settleViaFX()` → `StableFXAdapter` → `FxEscrow` |

### Permit2 (Required for cross-currency)

Before any cross-currency swap, the payer must:
1. `USDC.approve(PERMIT2, type(uint256).max)` — one time
2. Sign a Permit2 AllowanceTransfer for FxEscrow — per session

The SDK handles this automatically when building the transaction.

### StableFX Real Flow (Corrected)

FxEscrow (`0x867650F5eAe8df91445971f14d89fd84F0C9a9f8`) is an **ERC-1967 proxy**. It does not expose a `swap()` function. It operates as the **Permit2 spender** in a `permitWitnessTransferFrom` call.

**Off-chain (Circle StableFX API — `https://api.circle.com/v1/exchange/stablefx/`):**
1. `POST /quotes` (type=tradable) → quoteId + EIP-712 typedData
2. Taker signs typedData
3. `POST /trades` → contractTradeId
4. `POST /signatures/funding/presign` → funding typedData (SingleTradeWitness)
5. Taker signs funding typedData

**On-chain (`ConduitRouter.executeWithFX()`):**
6. `Permit2.permitWitnessTransferFrom(permit, transferDetails{to=FxEscrow}, taker, witness, typeString, sig)`
   → Permit2 transfers takerToken from taker → FxEscrow
   → FxEscrow delivers makerToken from maker → recipient

**API Key:** Get your Circle API key at **https://console.circle.com** (Circle Developer Console). Use TEST keys against Arc Testnet.

### Security

- `AtomicSettler` uses `ReentrancyGuard` — no partial states, full revert on failure
- No contract upgradability in v1 — immutable post-deployment
- Protocol parameters behind `Ownable` — intended for 2-of-3 multisig on mainnet
- Protocol fee capped at 30 bps (`MAX_PROTOCOL_FEE_BPS`)

## Testing

Tests run against a real Arc Testnet fork. No mocks.

```bash
# Fund your test wallet from faucet.circle.com first
forge test --fork-url https://rpc.testnet.arc.network -vvv
```

Test coverage:
- `DeclarationRegistry.t.sol` — register, resolve, deactivate, fuzz
- `ConduitRouter.t.sol` — direct send, declaration flow, fees, deadline enforcement
- `AtomicSettler.t.sol` — direct settlement, access control, fuzz

## App Routes

| Route | Description |
|---|---|
| `/` | Home — Direct Send (default tab) |
| `/create` | Create declaration → link card + QR code |
| `/pay/[declarationId]` | Public payment page — mobile-first, no jargon |
| `/links` | Manage all created declarations |
| `/history` | Transaction history |
| `/agent` | Agent wallet configuration + SDK reference |

### `/pay/[declarationId]` — Design Rules

This is the most public-facing page. Someone who has never heard of Conduit lands here.

- Loads and displays declaration **without a connected wallet**
- No crypto jargon — "Pay $10" not "fulfill declaration"
- Mobile-first — most users arrive via phone
- 3 taps to complete: connect wallet → pick token → confirm
- Receipt screen they can screenshot

### QR Code Specs

```tsx
<QRCodeSVG
  value={paymentUrl}
  size={400}
  bgColor="#000000"
  fgColor="#B2F55A"
  level="H"           // High — physical codes get damaged
  includeMargin={false}
/>
```

Downloads: PNG (1200×1200px) · PDF (A5, 148×210mm) · Print (browser dialog)

## V2 Roadmap (Do Not Build in V1)

These features are confirmed for v2. The v1 architecture does not preclude them.

| Feature | Notes |
|---|---|
| Natural language payments | Chat input → `PaymentInstruction` via Claude API. Zero contract changes. |
| Webhooks | Listen to `PaymentSettled` events, fire to registered URLs |
| Recurring payments | Requires contract changes |
| Multi-recipient splits | Requires contract changes |

## Environment Variables

### packages/contracts/.env

```bash
PRIVATE_KEY=0x...
ARC_TESTNET_RPC=https://rpc.testnet.arc.network
```

### packages/app/.env.local

```bash
NEXT_PUBLIC_CONDUIT_ROUTER=           # from Deploy.s.sol output
NEXT_PUBLIC_DECLARATION_REGISTRY=     # from Deploy.s.sol output
NEXT_PUBLIC_STABLEFX_ADAPTER=         # from Deploy.s.sol output
NEXT_PUBLIC_ATOMIC_SETTLER=           # from Deploy.s.sol output
NEXT_PUBLIC_ARC_RPC=https://rpc.testnet.arc.network
NEXT_PUBLIC_CHAIN_ID=5042002
NEXT_PUBLIC_EXPLORER=https://testnet.arcscan.app
NEXT_PUBLIC_APP_URL=https://app.conduit.xyz
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID= # from cloud.walletconnect.com
```

## Success Criteria

**Contracts:** ConduitRouter deployed on Arc Testnet (5042002). A direct send of EURC → USDC executes atomically end-to-end. A declaration is registered, resolved, and fulfilled. All tests pass.

**SDK:** `conduit.pay()`, `conduit.createLink()`, `conduit.fulfill()`, and `conduit.quote()` all work against deployed contracts.

**App:** Direct send works. A user creates a declaration and gets both a link card (downloadable PNG, 1200×630px) and a QR card (downloadable PDF, A5). Someone who has never heard of Conduit can scan the QR on their phone and complete a payment in under 3 taps. Black, green `#B2F55A`, sharp.

---

*CONDUIT™ · Arc's Native Agent Payment Protocol · Chain ID 5042002 · Arc Testnet · May 2026*
