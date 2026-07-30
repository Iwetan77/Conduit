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

**BLOCKED, not faked.** Attempting the real Solana devnet → Arc testnet transfer requires
a devnet Solana keypair funded with SOL (to pay the `depositForBurn` transaction fee) and
devnet USDC (the asset being bridged).

A devnet keypair already exists in this environment
(`~/.config/solana/id.json`, address `HpDTQVaAFQVuDBBuwM99Zfg7ZSfQG72qp95gYUFeQ2FD`),
configured against `https://api.devnet.solana.com`, with 0 SOL and no USDC token account.

Attempted to fund it for real:
```
$ solana airdrop 2
Requesting airdrop of 2 SOL
Error: airdrop request failed. This can happen when the rate limit is reached.

$ curl -s -X POST https://api.devnet.solana.com -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"requestAirdrop","params":["HpDTQVaAFQVuDBBuwM99Zfg7ZSfQG72qp95gYUFeQ2FD",1000000000]}'
{"jsonrpc":"2.0","error":{"code": 429,"message":"You've either reached your airdrop limit
today or the airdrop faucet has run dry. Please visit https://faucet.solana.com for
alternate sources of test SOL"}, "id": 1}
```

Retried at three different amounts (2 SOL, 1 SOL, 0.5 SOL) via both the `solana` CLI and
a direct RPC `requestAirdrop` call — all return HTTP 429. This is Solana's public devnet
faucet rate-limiting the sandbox's shared egress IP (almost certainly exhausted by other
activity on this IP today, not by this session). `faucet.solana.com`'s web UI is
captcha-gated and not something to script around.

Per the spec's explicit instruction ("You cannot obtain Solana devnet USDC or complete a
real transfer → STOP and report; do not fake it"), this phase stops here rather than
faking a transfer, inventing tx hashes, or mocking the attestation/mint. GATE 0 does not
pass yet — see `WHERE-I-STOPPED.md` for the exact resumption path once SOL is available
(fresh airdrop window, a manually-funded transfer to the keypair above, or an alternate
funded RPC/faucet).
