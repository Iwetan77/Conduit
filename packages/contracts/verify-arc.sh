#!/usr/bin/env bash
# Verify Conduit's Arc Testnet contracts on ArcScan (Blockscout).
#
# All six are deployed but unverified — checked via the explorer's
# getsourcecode API, which returns only {"Address":...} with no SourceCode
# when a contract is unverified. eth_getCode confirms the bytecode is there,
# so this is purely a source-publication gap.
#
# Constructor args are the fiddly part and are NOT optional: Blockscout
# matches the deployed bytecode, which has the encoded args appended, so a
# verify without them fails with a bytecode mismatch that reads like the wrong
# source file. Args below are taken from Deploy.s.sol and
# deployments/arc-testnet.json, where owner == deployer.
#
#   Usage: ./verify-arc.sh
set -euo pipefail
cd "$(dirname "$0")"

OWNER=0xf04a181eaB4CfABf7D13CCe64737782737cD0b22

DECLARATION_REGISTRY=0x57B8CF09bCa645E0c7e0c26E9b2edCd1a78E5Ce2
STABLEFX_ADAPTER=0x816eC143E6504E374838CD9675A1F45D1A580585
ATOMIC_SETTLER=0x611Fb259c22305AbE4b3f8F4246f2e33F41ca774
CONDUIT_ROUTER=0x8FD2695c606d6eB6976D60B119226ed6b615Ee1c
CURRENCY_REGISTRY=0x813f4D0b6dC42da94C0499836ea07067780105e5
SETTLEMENT_PREF_REGISTRY=0xE7eFA65C4B722cB223e7D18ee87D7ACd7403E75c

VERIFY=(forge verify-contract
  --chain-id 5042002
  --verifier blockscout
  --verifier-url https://testnet.arcscan.app/api
  --compiler-version 0.8.24
  --watch)

echo "── DeclarationRegistry ──"
"${VERIFY[@]}" "$DECLARATION_REGISTRY" src/DeclarationRegistry.sol:DeclarationRegistry \
  --constructor-args "$(cast abi-encode 'c(address)' "$OWNER")"

echo "── StableFXAdapter ──"
"${VERIFY[@]}" "$STABLEFX_ADAPTER" src/StableFXAdapter.sol:StableFXAdapter \
  --constructor-args "$(cast abi-encode 'c(address)' "$OWNER")"

echo "── AtomicSettler ──"
"${VERIFY[@]}" "$ATOMIC_SETTLER" src/AtomicSettler.sol:AtomicSettler \
  --constructor-args "$(cast abi-encode 'c(address,address)' "$OWNER" "$STABLEFX_ADAPTER")"

echo "── ConduitRouter ──"
"${VERIFY[@]}" "$CONDUIT_ROUTER" src/ConduitRouter.sol:ConduitRouter \
  --constructor-args "$(cast abi-encode 'c(address,address,address,address)' \
      "$OWNER" "$DECLARATION_REGISTRY" "$ATOMIC_SETTLER" "$STABLEFX_ADAPTER")"

echo "── CurrencyRegistry ──"
"${VERIFY[@]}" "$CURRENCY_REGISTRY" src/CurrencyRegistry.sol:CurrencyRegistry \
  --constructor-args "$(cast abi-encode 'c(address)' "$OWNER")"

# No constructor args — the source had no constructor declaration.
echo "── SettlementPreferenceRegistry ──"
"${VERIFY[@]}" "$SETTLEMENT_PREF_REGISTRY" \
  src/SettlementPreferenceRegistry.sol:SettlementPreferenceRegistry

echo
echo "Done. Re-check with:"
echo "  curl -s 'https://testnet.arcscan.app/api?module=contract&action=getsourcecode&address=<addr>'"
echo "A verified contract returns SourceCode and ContractName; an unverified one returns only Address."
