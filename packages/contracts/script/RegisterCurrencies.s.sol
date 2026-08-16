// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {CurrencyRegistry} from "../src/CurrencyRegistry.sol";

/// @title RegisterCurrencies
/// @notice Adds currencies to an already-deployed CurrencyRegistry.
///
/// Deploy.s.sol registers the full set at deploy time, which is right for a
/// fresh stack and wrong for adding one currency later: re-running it would
/// deploy six new contracts and move every address the app and API point at.
/// This touches only the registry.
///
/// Usage:
///   CURRENCY_REGISTRY=0x... forge script script/RegisterCurrencies.s.sol \
///     --rpc-url arc_testnet --broadcast
///
/// Owner-only on the registry side, so the PRIVATE_KEY must be the deployer's.
/// Skips anything already registered rather than reverting the whole run --
/// registerCurrency reverts on a duplicate, and one already-present code should
/// not stop the rest.
contract RegisterCurrencies is Script {
    // AllUnity's Swiss franc and euro, both 6dp. Addresses and decimals came
    // from a live StableFX quote plus a decimals() read on Arc, not from a
    // listing page -- same rule as every other currency in this repo.
    address constant CHFAU = 0x74ef206336F87843485E5f3fdaEA13ba4ec309E7;
    address constant EURAU = 0x67521a2b4b385eEB2c65695C23457e04dC8A6331;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        CurrencyRegistry registry = CurrencyRegistry(vm.envAddress("CURRENCY_REGISTRY"));

        vm.startBroadcast(deployerKey);

        // "EUA" rather than "EUR": the key is bytes3, EURC already holds "EUR",
        // and registerCurrency rejects a duplicate. This is the registry's
        // 3-byte handle, not an ISO code -- the API and app call it "EURAU".
        _register(registry, "CHF", CHFAU, 6);
        _register(registry, "EUA", EURAU, 6);

        vm.stopBroadcast();
    }

    function _register(CurrencyRegistry registry, bytes3 code, address token, uint8 decimals) internal {
        // registerCurrency also checks `decimals` against the token's own
        // decimals() and reverts on a mismatch, so a wrong value here fails
        // loudly rather than being stored.
        if (registry.getCurrency(code).token != address(0)) {
            console2.log("already registered, skipping:", string(abi.encodePacked(code)));
            return;
        }
        registry.registerCurrency(code, token, decimals);
        console2.log("registered:", string(abi.encodePacked(code)), token);
    }
}
