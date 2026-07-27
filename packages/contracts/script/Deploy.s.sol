// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {DeclarationRegistry} from "../src/DeclarationRegistry.sol";
import {StableFXAdapter} from "../src/StableFXAdapter.sol";
import {AtomicSettler} from "../src/AtomicSettler.sol";
import {ConduitRouter} from "../src/ConduitRouter.sol";
import {CurrencyRegistry} from "../src/CurrencyRegistry.sol";
import {SettlementPreferenceRegistry} from "../src/SettlementPreferenceRegistry.sol";

/// @title Deploy
/// @notice Deploys the full Conduit protocol stack to Arc Testnet (Chain ID: 5042002).
///
/// Usage:
///   1. Copy packages/contracts/.env.example → .env and fill PRIVATE_KEY
///   2. Run: forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast --slow
///   3. Addresses are written to deployments/arc-testnet.json — the SDK reads from
///      there. No copy-paste into .env.local required (though the console log still
///      prints them for convenience).
///
/// Deployment order matches the dependency graph:
///   DeclarationRegistry → StableFXAdapter → AtomicSettler → ConduitRouter →
///   CurrencyRegistry → SettlementPreferenceRegistry → wire authorizations →
///   register currencies confirmed live in docs/fx-capability.md
///
/// CCTPAdapter.sol is intentionally NOT deployed here — cross-chain is parked for
/// v1 per the architecture delta. The file still exists in src/ as a future hook.
contract Deploy is Script {
    // ── Arc Testnet Config ────────────────────────────────────────────────────
    uint256 constant ARC_CHAIN_ID = 5042002;

    // Currencies confirmed live on StableFX + on-chain in Phase 0 (docs/fx-capability.md).
    // JPYC and PHPC are deliberately excluded — not quotable on StableFX today.
    address constant USDC = 0x3600000000000000000000000000000000000000;
    address constant EURC = 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a;
    address constant BRLA = 0x8629020763F6239643a02e664a25BF4AD7787254;
    address constant AUDF = 0xd2a530170D71a9Cfe1651Fb468E2B98F7Ed7456b;
    address constant MXNB = 0x836F73Fbc370A9329Ba4957E47912DfDBA6BA461;
    address constant QCAD = 0x23d7CFFd0876f3ABb6B074287ba2aeefBc83825d;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address owner = deployer; // In production: use 2-of-3 multisig

        require(block.chainid == ARC_CHAIN_ID, "Deploy: wrong chain. Expected Arc Testnet 5042002");

        console2.log("=== Conduit Protocol Deployment ===");
        console2.log("Chain ID:  ", block.chainid);
        console2.log("Deployer:  ", deployer);
        console2.log("Block:     ", block.number);
        console2.log("");

        vm.startBroadcast(deployerKey);

        // ── 1. DeclarationRegistry ────────────────────────────────────────────
        DeclarationRegistry registry = new DeclarationRegistry(owner);
        console2.log("DeclarationRegistry:            ", address(registry));

        // ── 2. StableFXAdapter ────────────────────────────────────────────────
        StableFXAdapter fxAdapter = new StableFXAdapter(owner);
        console2.log("StableFXAdapter:                ", address(fxAdapter));

        // ── 3. AtomicSettler ──────────────────────────────────────────────────
        AtomicSettler settler = new AtomicSettler(owner, address(fxAdapter));
        console2.log("AtomicSettler:                  ", address(settler));

        // ── 4. ConduitRouter ──────────────────────────────────────────────────
        ConduitRouter router = new ConduitRouter(
            owner,
            address(registry),
            address(settler),
            address(fxAdapter)
        );
        console2.log("ConduitRouter:                  ", address(router));

        // ── 5. CurrencyRegistry ───────────────────────────────────────────────
        CurrencyRegistry currencyRegistry = new CurrencyRegistry(owner);
        console2.log("CurrencyRegistry:                ", address(currencyRegistry));

        // ── 6. SettlementPreferenceRegistry ───────────────────────────────────
        SettlementPreferenceRegistry prefRegistry = new SettlementPreferenceRegistry();
        console2.log("SettlementPreferenceRegistry:    ", address(prefRegistry));

        // ── 7. Wire Authorizations ────────────────────────────────────────────
        fxAdapter.setAuthorizedCaller(address(settler), true);
        settler.setAuthorizedRouter(address(router), true);
        router.setSettlementPreferenceRegistry(address(prefRegistry));

        // ── 8. Register currencies confirmed live in Phase 0 ─────────────────
        currencyRegistry.registerCurrency("USD", USDC, 6);
        currencyRegistry.registerCurrency("EUR", EURC, 6);
        currencyRegistry.registerCurrency("BRL", BRLA, 18);
        currencyRegistry.registerCurrency("AUD", AUDF, 6);
        currencyRegistry.registerCurrency("MXN", MXNB, 6);
        currencyRegistry.registerCurrency("CAD", QCAD, 6);

        console2.log("");
        console2.log("=== Authorizations + currency registrations set ===");

        vm.stopBroadcast();

        // ── Write deployments/arc-testnet.json ────────────────────────────────
        string memory json = "deployment";
        vm.serializeUint(json, "chainId", ARC_CHAIN_ID);
        vm.serializeAddress(json, "deployer", deployer);
        vm.serializeAddress(json, "declarationRegistry", address(registry));
        vm.serializeAddress(json, "stableFXAdapter", address(fxAdapter));
        vm.serializeAddress(json, "atomicSettler", address(settler));
        vm.serializeAddress(json, "conduitRouter", address(router));
        vm.serializeAddress(json, "currencyRegistry", address(currencyRegistry));
        vm.serializeAddress(json, "settlementPreferenceRegistry", address(prefRegistry));
        vm.serializeAddress(json, "usdc", USDC);
        vm.serializeAddress(json, "eurc", EURC);
        vm.serializeAddress(json, "brla", BRLA);
        vm.serializeAddress(json, "audf", AUDF);
        vm.serializeAddress(json, "mxnb", MXNB);
        string memory finalJson = vm.serializeAddress(json, "qcad", QCAD);

        // Foundry's fs_permissions check is a literal path-prefix match — it does not
        // canonicalize ".." segments — so this must be the real absolute path, not
        // projectRoot() + "/../..". Matches fs_permissions in foundry.toml.
        string memory outPath = "/home/iwetan/conduit/deployments/arc-testnet.json";
        vm.writeJson(finalJson, outPath);
        console2.log("");
        console2.log("Wrote", outPath);
    }
}
