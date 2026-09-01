// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ConduitRouter} from "../src/ConduitRouter.sol";

/// @title RedeployRouter — Phase A6
/// @notice Deploys ONLY the router, against the registries already on chain.
///
/// @dev Deliberately not `Deploy.s.sol`. That script builds the whole protocol
///      from nothing, including fresh registries — which is exactly wrong here.
///      `DeclarationRegistry`, `CurrencyRegistry` and
///      `SettlementPreferenceRegistry` must keep their existing addresses, or
///      every declaration a merchant has already registered stops resolving and
///      every payment link pointing at one breaks. Running the full deploy for
///      a router change would silently orphan all of them.
///
///      The old router is abandoned, not upgraded. It has no pause and no
///      migration path; A0 confirmed it holds no fees (protocolFeeBps is 0 and
///      every accumulatedFees entry is zero), so nothing has to be withdrawn
///      before walking away from it.
contract RedeployRouter is Script {
    uint256 constant ARC_CHAIN_ID = 5042002;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        // Read from the environment rather than hardcoded, so this script is
        // the same one used for any later redeploy.
        address declarations = vm.envAddress("DECLARATION_REGISTRY");
        address currencies = vm.envAddress("CURRENCY_REGISTRY");
        address preferences = vm.envAddress("SETTLEMENT_PREFERENCE_REGISTRY");

        // The owner of the new router. Defaults to the deployer only because a
        // multisig cannot be conjured here; see OWNERSHIP in the phase notes.
        address owner = vm.envOr("ROUTER_OWNER", deployer);
        // May pause payments and nothing else. Unset means no guardian, which
        // is the state the old router was in — not a regression, just not yet
        // the improvement.
        address guardian = vm.envOr("ROUTER_GUARDIAN", address(0));

        require(block.chainid == ARC_CHAIN_ID, "wrong chain, expected Arc Testnet 5042002");
        require(declarations.code.length > 0, "DECLARATION_REGISTRY has no code");
        require(currencies.code.length > 0, "CURRENCY_REGISTRY has no code");
        require(preferences.code.length > 0, "SETTLEMENT_PREFERENCE_REGISTRY has no code");

        console2.log("=== Redeploying ConduitRouter (Phase A6) ===");
        console2.log("Deployer:                  ", deployer);
        console2.log("Owner:                     ", owner);
        console2.log("Guardian:                  ", guardian);
        console2.log("DeclarationRegistry:       ", declarations);
        console2.log("CurrencyRegistry:          ", currencies);
        console2.log("SettlementPreferenceReg:   ", preferences);

        vm.startBroadcast(deployerKey);

        ConduitRouter router = new ConduitRouter(owner, declarations, currencies);

        // A0 found the OLD router had this set. It is not inherited by a new
        // deployment — the constructor never sets it — so it is set here, or
        // the recipient-preference enforcement silently does not exist.
        router.setSettlementPreferenceRegistry(preferences);

        if (guardian != address(0)) {
            router.setGuardian(guardian);
        }

        vm.stopBroadcast();

        console2.log("");
        console2.log("ConduitRouter (NEW):       ", address(router));
        console2.log("");
        console2.log("Remaining, and NOT done by this script:");
        console2.log(" - transferOwnership to a Safe, then acceptOwnership from it");
        console2.log(" - rotate the deployer key");
        console2.log(" - set CONDUIT_ROUTER_ADDRESS to the address above");
    }
}
