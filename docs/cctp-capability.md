# CCTP V2 capability — Solana → Arc

Status: **Phase 0.1 confirmed. Phase 0.2 (live transfer) BLOCKED on devnet SOL faucet
exhaustion — see "Live bridge proof" below.** GATE 0 does not pass yet.

## Sources consulted (live, 2026-07-30)

- `https://developers.circle.com/cctp/concepts/supported-chains-and-domains` — canonical
  supported-chain + domain table.
- `https://developers.circle.com/cctp/references/contract-addresses` — TokenMessengerV2 /
  MessageTransmitterV2 testnet addresses.
- `https://developers.circle.com/cctp/references/solana-programs` — Solana devnet program
  IDs.
- `https://developers.circle.com/stablecoins/usdc-contract-addresses` — USDC token
  addresses.

All fetched via WebFetch (which summarizes through a smaller model — hex strings from a
summarizer are not self-trustworthy). Cross-checked instead against this repo's own
pre-existing `packages/contracts/src/CCTPAdapter.sol` and
`packages/contracts/src/interfaces/ICCTPTokenMessenger.sol` (written in the initial
monorepo commit, `64989fc`, well before this session) and against
`packages/contracts/script/Deploy.s.sol`'s `USDC` constant and `deployments/arc-testnet.json`'s
`usdc` field. **Every address below is identical across the live docs fetch and this
repo's independently-sourced prior contract code.** That agreement is the actual
verification here, not the WebFetch summary alone.

## Arc

Arc is a CCTP V2 domain — domain ID 26, testnet only (no Arc mainnet listed in Circle's
docs as of this check).
- `TokenMessengerV2`: `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`
- `MessageTransmitterV2`: `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`
- USDC (native, 6 decimals): `0x3600000000000000000000000000000000000000`
- Capability table (as Circle's docs list it, columns are `Source (Standard transfer)` /
  `Source (Fast transfer)` / `Forwarding Service`): Arc = `✅ / N/A / ✅`. **Arc cannot
  originate a Fast Transfer burn** (only Standard, ~15+ min finality, if burning FROM
  Arc). This does NOT block our direction: we are burning on Solana (source) and minting
  ON Arc (destination). Fast Transfer eligibility is a source-chain finality property —
  any CCTP V2 domain, including Arc, can receive a Fast-Transfer-attested mint via
  `MessageTransmitterV2.receiveMessage()`, because minting a validly-attested message is
  not finality-sensitive the way burning-then-attesting is. Confirmed this reading against
  Circle's own architecture description (Iris attests once the source chain reaches the
  requested finality threshold; the destination-side mint call has no separate "fast" vs
  "standard" code path — it's the same `receiveMessage()` either way).

## Solana

- **CCTP V2 domain: YES.** Domain ID **5**. Both mainnet and devnet supported (Circle's
  docs state official testnets/devnets are supported whenever the mainnet is listed).
- `TokenMessengerMinterV2` program ID (devnet): `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe`
- `MessageTransmitterV2` program ID (devnet): `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC`
- USDC devnet mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
- Capability: `✅ / ✅ / ✅` — Solana supports Fast Transfer as a source domain. This is
  the leg we actually burn on, so Fast Transfer applies to our flow end to end.

## Conclusion

Arc IS a CCTP V2 domain. Solana IS a CCTP V2 domain with Fast Transfer support as a
source. The Solana → Arc route is protocol-supported. **Not parked.** Phase 1+ may proceed
once Phase 0.2's live proof lands — but per the spec, GATE 0 requires that live proof
before unlocking Phase 1, so work is paused here until it does.

## Live bridge proof

**Real transfer completed 2026-07-30.** The environment's own devnet SOL/USDC faucets
were rate-limited on the sandbox's shared IP (see the funding blocker note below, kept
for the record); the user funded the Solana devnet keypair directly (5 SOL) and via
Circle's faucet (20 USDC, `https://faucet.circle.com`, Solana Devnet), which unblocked
the transfer.

Executed via Circle's own official quickstart script
(`https://developers.circle.com/cctp/quickstarts/transfer-usdc-solana-to-arc`, "Direct
mint" variant — burn on Solana, poll Iris, `receiveMessage` directly on Arc, no Hook),
run as a throwaway TypeScript script outside the repo (`@solana/kit`,
`@solana-program/system`, `@solana-program/token`, `viem` — not added to any package.json,
this was proof-of-capability only, not shipped code). Amount: 1,000,000 minor units
(1.0 USDC). `maxFee`: 500 minor units. `minFinalityThreshold`: 1000 (Fast Transfer).

- **Payer (Solana devnet):** `HpDTQVaAFQVuDBBuwM99Zfg7ZSfQG72qp95gYUFeQ2FD`
- **Recipient (Arc testnet):** `0xf04a181eaB4CfABf7D13CCe64737782737cD0b22` (this
  project's existing Arc deployer address, already funded for gas)
- **Burn tx (Solana devnet):**
  `5M1Y4YArneHqTBN7PYLmxXMpK6BTfJCm4VB2ujRvDMZVfc2PrwZi26LV4Y3NpmuLTLpBZgzBnrSP6o3yC697GVCg`
- **Mint tx (Arc testnet):**
  `0x09cd09c45dde9d2c0e1c30020f793dd5251664b4c2b9893a932a5e4e00d24d15`
- **Attestation latency observed:** ~14.1s from burn confirmation to Iris returning
  `status: "complete"` (well within the documented ~8–30s Fast Transfer window).
- **Balance confirmation:** `cast receipt` on the mint tx shows a `Transfer` event on the
  Arc USDC contract (`0x3600000000000000000000000000000000000000`) from the zero address
  to the recipient for **999900** minor units — the burned 1,000,000 minus a 100-minor-unit
  CCTP fee actually charged (well under the 500 maxFee cap; fee amount is emitted on-chain
  in the `MessageTransmitterV2` log too, both values agree). `status: 1 (success)` on the
  mint transaction. This on-chain Transfer event is the balance-increase proof — exact
  amount, exact recipient, verifiable independently by anyone querying Arc testnet.

**Conclusion: GATE 0 satisfied for real.** The Solana devnet → Arc testnet CCTP V2 Fast
Transfer route works end to end: burn → attest (~14s) → mint, with the fee/amount
accounting exactly matching CCTP's documented behavior. Phase 1 may proceed.

### Funding blocker (historical, resolved)

Before the user funded the address, the environment's own SOL/USDC faucet paths were
exhausted:
```
$ solana airdrop 2
Requesting airdrop of 2 SOL
Error: airdrop request failed. This can happen when the rate limit is reached.
```
This was Solana's public devnet faucet rate-limiting the sandbox's shared egress IP.
`faucet.solana.com` (SOL) and `faucet.circle.com` (USDC) are both captcha/human-gated and
were not scripted around — the user funded the keypair manually instead. See git history
for the WIP commit documenting this blocker at the time.
