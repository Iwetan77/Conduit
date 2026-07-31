# Circle Unified Balance Kit / Gateway — capability confirmation

Status: confirmed live, 2026-07-31. Package genuinely exists (verified directly against
the npm registry, not just a docs summary) and the underlying REST API's base URLs and
endpoint shapes were confirmed by inspecting the actual published package contents
(`npm pack @circle-fin/unified-balance-kit@1.3.1`), not by trusting an AI-summarized docs
page alone.

## Package

- **npm**: `@circle-fin/unified-balance-kit` — confirmed real via
  `https://registry.npmjs.org/@circle-fin/unified-balance-kit`, latest `1.3.1`,
  description "SDK for cross-chain USDC deposits, spending, and balance queries."
- This is a **TypeScript/JavaScript-only SDK**. Its `spend`/`deposit` functions take an
  `adapter` parameter that wraps a real chain-specific signer (an ethers/viem-style signer
  for EVM, a Solana `Signer`/`Keypair`-shaped object for Solana) — it is not something a
  Go process can import. **This repo's API is Go** (`packages/api`), so this SDK itself is
  not used directly; see "Integration approach" below.

## The real REST API underneath (this is what gets used)

Found by inspecting the compiled package (`package/index.cjs`) for the literal base URLs
and fetch call sites, not by guessing:

- **Testnet base URL**: `https://gateway-api-testnet.circle.com`
- **Mainnet base URL**: `https://gateway-api.circle.com`
- Endpoints (all confirmed from real Zod schemas and fetch call sites in the shipped
  code, not documentation prose):
  - `GET /v1/info` — Gateway domain/chain info, `processedHeight` per domain.
  - `POST /v1/balances` — confirmed (already-deposited) USDC balances. Request:
    `{ token: "USDC", sources: [{ depositor, domain? }] }`. Response:
    `{ token, balances: [{ domain, depositor, balance }] }`.
  - `POST /v1/deposits` — pending (not-yet-confirmed) deposits. Same request shape as
    balances. Response: `{ token, deposits: [{ depositor, domain, transactionHash,
    amount, status, blockHeight, blockHash, blockTimestamp }] }`.
  - `POST /v1/estimate` — fee estimate for a spend, before submitting it.
  - `POST /v1/transfer` — submits one or more signed "burn intents" (see below).
    Response: `{ attestation?, signature?, transferId?, fees?, expirationBlock? }`.
  - `GET /v1/transfer/{id}` — status polling. Response: `{ destinationDomain?, status:
    "pending"|"confirmed"|"finalized"|"failed"|"expired", burnIntents?, transactionHash?,
    fees?, attestation?: { payload, signature, expirationBlock } }`.
  - No `Authorization`/API-key header construction found anywhere near these call sites
    — the balances/deposits/transfer endpoints appear to be public/permissionless,
    consistent with Circle's Iris CCTP attestation API (public, keyed by on-chain
    address/tx hash, not by API key). Authorization for a *spend* comes from the burn
    intent's own cryptographic signature, not a bearer token.

**This means Conduit's Go API can call Gateway directly over plain HTTP/JSON, exactly
like the existing StableFX integration (`internal/fx/stablefx.go`) — no JS runtime, no
sidecar process, no FFI. This was the single biggest open question from Phase 0's audit
and it resolves cleanly.**

## The real mechanism — NOT a single burn-and-forget (important, differs from raw CCTP)

Confirmed against both the compiled SDK and Circle's own Solana quickstart guide
(`developers.circle.com/gateway/quickstarts/unified-balance-solana`): Gateway is a
**deposit-then-spend** model, not a burn-per-payment model like the raw CCTP integration
this replaces.

1. **Deposit** (on-chain, real gas, first time only unless the payer wants to top up):
   the payer transfers USDC into a Gateway-custodied PDA/contract on their source chain
   (`GatewayWallet` contract for EVM via ERC-3009 `depositWithAuthorization`, or a
   `deposit()` instruction into a `gateway_deposit` PDA on Solana). This must reach
   confirmation before it can be spent.
2. **Spend** (off-chain signature, gasless for the payer): once deposited balance exists,
   the payer signs a **burn intent** message (not a transaction — a signed message,
   Circle's relayer submits it) authorizing Gateway to burn from their deposited balance
   and mint on the destination chain. `POST /v1/transfer` takes this signed intent and
   returns an attestation; `GET /v1/transfer/{id}` polls until `status: "finalized"` and a
   destination `transactionHash` appears.

**Consequence for a first-time payer**: funding an intent is genuinely two payer
signatures, not one — a real on-chain deposit signature (costs gas) followed by a
gasless burn-intent signature (a message, not a transaction). This is an honest
discrepancy against the spec's "the payer signs once" framing, worth stating plainly
rather than glossing over: what the spec means by "signs once" is one continuous
wallet-interaction *flow* (like this product's existing StableFX path, which already
asks for two EIP-712 signatures — quote-ack, then Permit2 funding — under the same "sign
once" umbrella), not literally one cryptographic signature. The bridging pre-stage's
state machine already has room for this: `burn_submitted` covers the deposit landing,
`attestation_pending`/`attested` cover the burn-intent → Gateway attestation cycle, no
new states needed structurally.

For a payer who already has a Gateway balance from a prior payment (deposit once, spend
many times, exactly like the product name "Unified Balance" implies), a later payment is
**one signature only** — the burn intent — since the deposit step is skipped entirely.
This is actually a UX improvement over raw CCTP for repeat payers, at the cost of a
two-signature first payment.

## Source chains — the real, verified list (25 chain deployments = 12 unique chains + Arc, mainnet+testnet)

Extracted by parsing every `defineChain({...})` block in the shipped package for a
`gateway: { domain: ... }` sub-object — a chain only appears here if Gateway actually
lists a domain/contracts for it, not just if the SDK knows the chain exists generally
(this distinction matters, see Sui below).

| Chain | Gateway domain | Testnet available |
|---|---|---|
| Arc | 26 | Yes (testnet-only — no Arc mainnet exists yet, consistent with every prior finding in this project) |
| Ethereum | 0 | Yes (Sepolia) |
| Avalanche | 1 | Yes (Fuji) |
| Optimism | 2 | Yes (Sepolia) |
| Arbitrum | 3 | Yes (Sepolia) |
| Base | 6 | Yes (Sepolia) |
| Polygon | 7 | Yes (Amoy) |
| Solana | 5 | Yes (Devnet) |
| Unichain | 10 | Yes (Sepolia) |
| HyperEVM | 19 | Yes |
| World Chain | 14 | Yes (Sepolia) |
| Sei | 16 | Yes |
| Sonic | 13 | Yes |

**Solana: YES, included** (domain 5, has a real `gateway` block on both mainnet and
devnet — the same domain ID as raw CCTP, since Gateway is CCTP-domain-native).

**Sui: NOT included**, checked explicitly rather than assumed. Sui has a full chain
definition in this package (`type: 'sui'`, CCTP V1 domain 8, real token addresses) — the
SDK knows about Sui generally, elsewhere in Circle's broader stablecoin-kits tooling —
but its `defineChain({...})` block has **no `gateway:` key at all**, unlike every chain
in the table above. This is exactly the kind of thing the spec said not to assume: Sui
*looks* supported at a glance (it's a real, well-documented chain in this same package)
but is concretely absent from Gateway specifically.

EVM chains all ride the identical code path (ERC-3009 `depositWithAuthorization` +
EIP-712-shaped burn intent signing) — nothing chain-specific beyond contract addresses
and domain IDs, matching the spec's expectation. Solana has its own program-based deposit
instruction and its own message-signing shape for the burn intent, structurally distinct
from EVM but conceptually the same two-step flow.

## Arc as destination

Arc (domain 26, testnet) has a real `gateway` block with `contracts.v1.{wallet,minter}`
(a `GatewayWallet` and a `GatewayMinter` contract on Arc testnet, addresses embedded in
the package but not yet independently address-verified against a block explorer the way
the CCTP `TokenMessengerV2`/`MessageTransmitterV2` addresses were in the earlier CCTP
work — do this before going live with real funds in Phase 1's implementation, the same
verification discipline used for those addresses previously). Arc's plain CCTP
`TokenMessengerV2`/`MessageTransmitterV2` addresses embedded in this same package file
are **byte-for-byte identical** to the ones independently confirmed in
`docs/cctp-capability.md` from the earlier CCTP session — strong cross-confirmation this
package's data is accurate, not stale or wrong.

## Integration approach for Phase 1.1

Given the Go-only backend and the confirmed plain-REST API: `FundingProvider` will be a
Go HTTP client hitting `gateway-api-testnet.circle.com` directly (same pattern as
`internal/fx/stablefx.go`), not a wrapper around the npm package. `UnifiedBalance` maps to
`POST /v1/balances` (+ `/v1/deposits` for pending-but-not-yet-confirmed amounts). `Fund`
covers both steps (deposit-tx-building for the payer to sign, then accepting the reported
deposit + the payer's burn-intent signature, then `POST /v1/transfer`). `Status` maps to
`GET /v1/transfer/{id}`, translated into the existing `bridge_transfers` state machine.

## Exact protocol details (fetched from real, authoritative sources — not guessed)

### Solana `deposit` instruction — real on-chain Anchor IDL

Fetched live via `anchor idl fetch GATEwdfmYNELfp5wDmmR6noSr2vHnAfBPMm2PvCzX5vu --provider.cluster devnet`
(the real Gateway Wallet program on Solana devnet, address confirmed against the SDK's
own `GATEWAY_WALLET_SOLANA_DEVNET` constant) — this is ground truth pulled directly off
the chain, not reverse-engineered from JS:

- Program: `gateway_wallet`, deployed at `GATEwdfmYNELfp5wDmmR6noSr2vHnAfBPMm2PvCzX5vu`
  (devnet). Mainnet uses the same address.
- `deposit` instruction discriminator: `[22, 0]` (this program uses 2-byte discriminators,
  not Anchor's usual 8-byte sighash — confirmed directly from the fetched IDL).
- Accounts: `payer` (signer, writable — pays the tx fee), `owner` (signer — the balance
  holder, can differ from `payer`), `gateway_wallet` (PDA, seed `"gateway_wallet"`),
  `owner_token_account` (writable, the payer's USDC ATA), `custody_token_account` (PDA,
  seeds `"gateway_wallet_custody"` + the token mint), `deposit` (PDA, seeds
  `"gateway_deposit"` + token mint + `owner`), `depositor_denylist` (PDA, seeds
  `"denylist"` + `owner`), `token_program`, `system_program`, `event_authority` (PDA,
  seed `"__event_authority"`), `program`.
- Args: `amount: u64`.

### Burn-intent binary encoding for Solana signing — real, byte-exact, from the shipped SDK

Extracted directly from `encodeBurnIntentForSolana()` in the published package (not
guessed): a 16-byte domain prefix (`0xff` followed by 15 zero bytes) + magic-tagged,
big-endian binary encoding of the `BurnIntent`/`TransferSpec` structs (the exact fields
Circle's own EIP-712 types use for EVM chains — this same logical message, just encoded
as raw bytes instead of hashed via EIP-712 domain separation, since Solana has no EIP-712
equivalent):

```
[16 bytes] domain prefix: 0xff, then 15 × 0x00
[4 bytes]  BURN_INTENT_MAGIC = 0x070afbc2 (big-endian)
[32 bytes] maxBlockHeight (uint256 big-endian)
[32 bytes] maxFee (uint256 big-endian)
[4 bytes]  transferSpecLength (uint32 big-endian)
[4 bytes]  TRANSFER_SPEC_MAGIC = 0xca85def7 (big-endian)
[4 bytes]  version (uint32 big-endian)
[4 bytes]  sourceDomain (uint32 big-endian) -- 5 for Solana
[4 bytes]  destinationDomain (uint32 big-endian) -- 26 for Arc
[32 bytes] sourceContract (bytes32 -- Gateway Wallet program, left-padded)
[32 bytes] destinationContract (bytes32 -- Gateway Minter contract on Arc, left-padded)
[32 bytes] sourceToken (bytes32 -- USDC mint/token address, left-padded)
[32 bytes] destinationToken (bytes32 -- USDC on Arc, left-padded)
[32 bytes] sourceDepositor (bytes32 -- payer's Solana address)
[32 bytes] destinationRecipient (bytes32 -- Conduit's Arc relayer address, left-padded)
[32 bytes] sourceSigner (bytes32 -- normally == sourceDepositor)
[32 bytes] destinationCaller (bytes32 -- zero = any relayer may submit, same convention as raw CCTP)
[32 bytes] value (uint256 big-endian -- amount to spend, minor units)
[32 bytes] salt (bytes32 -- random nonce)
[4 bytes]  hookDataLength (uint32 big-endian)
[N bytes]  hookData (empty for a plain payment)
```

The resulting buffer is signed directly with the payer's Solana ed25519 key (a message
signature, exactly like `solana-go`'s `PrivateKey.Sign()` — already proven working in
the earlier CCTP session, no new signing primitive needed) — **not** a transaction, no
gas, no on-chain footprint for this step. This is submitted to `POST /v1/transfer` as
`{ intent: <the same fields, as strings>, signature: <hex> }` (exact JSON field names to
be confirmed against a real request/response during implementation, per this project's
established practice of verifying live rather than trusting a static spec down to the
last field name).

### Destination mint — Arc is a confirmed forwarder destination, no Conduit signing needed

Arc's chain definition has `gateway.forwarderSupported.destination: true`. This means
Circle's own relayer submits the final `gatewayMint` call on Arc automatically when the
transfer request opts into the forwarder (an `enableForwarder` request flag, seen on the
`/v1/estimate` endpoint and implied for `/v1/transfer` too) — **Conduit does not need to
build, sign, or submit an Arc-side mint transaction at all**, unlike the raw CCTP
integration this replaces, where Conduit's own relayer key had to submit `receiveMessage`
itself. This is a meaningful simplification: `FundingProvider.Status` just polls
`GET /v1/transfer/{id}` until `status: "finalized"` and a `transactionHash` appears.

## Live testnet funding test

Not yet attempted as of writing this doc (Phase 1.0 is capability confirmation only, per
the spec's own phase split — code and the live test come in Phase 1.1/GATE 1). Solana
Devnet is confirmed Gateway-testnet-available and this environment already has a funded
Solana devnet keypair (`HpDTQVaAFQVuDBBuwM99Zfg7ZSfQG72qp95gYUFeQ2FD`, ~4.9 SOL / ~11 USDC
remaining from the earlier CCTP work) — reused as the Phase 1.1 live-test source, per the
spec's "if testnet Gateway isn't available, document that and stop" instruction: testnet
Gateway **is** available for Solana, so a real live test is expected to be possible, not
blocked. If it turns out blocked for a different reason during implementation, that will
be documented honestly at that point, not assumed now.
