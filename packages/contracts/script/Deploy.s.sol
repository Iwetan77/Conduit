// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {DeclarationRegistry} from "../src/DeclarationRegistry.sol";
import {StableFXAdapter} from "../src/StableFXAdapter.sol";
import {CCTPAdapter} from "../src/CCTPAdapter.sol";
import {AtomicSettler} from "../src/AtomicSettler.sol";
import {ConduitRouter} from "../src/ConduitRouter.sol";

/// @title Deploy
/// @notice Deploys the full Conduit protocol stack to Arc Testnet (Chain ID: 5042002).
///
/// Usage:
///   1. Copy packages/contracts/.env.example → .env and fill PRIVATE_KEY
///   2. Run: forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast --slow
///   3. Copy the logged addresses into packages/app/.env.local
///
/// Deployment order matches the dependency graph:
///   DeclarationRegistry → StableFXAdapter → CCTPAdapter →
///   AtomicSettler → ConduitRouter → wire authorizations
contract Deploy is Script {
    // ── Arc Testnet Config ────────────────────────────────────────────────────
    uint256 constant ARC_CHAIN_ID = 5042002;

    // Protocol owner — replace with multisig before mainnet
    address constant PROTOCOL_OWNER = address(0); // Set via env or override

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address owner = deployer; // In production: use 2-of-3 multisig

        require(block.chainid == ARC_CHAIN_ID, "Deploy: wrong chain. Expected Arc Testnet 5042002");

        console2.log("=== Conduit Protocol Deployment ===");
        console2.log("Chain ID:  ", block.chainid);
        console2.log("Deployer:  ", deployer);
        console2.log("Block:     ", block.number);
        console2.log("Timestamp: ", block.timestamp);
        console2.log("");

        vm.startBroadcast(deployerKey);

        // ── 1. DeclarationRegistry ────────────────────────────────────────────
        DeclarationRegistry registry = new DeclarationRegistry(owner);
        console2.log("DeclarationRegistry:", address(registry));

        // ── 2. StableFXAdapter ────────────────────────────────────────────────
        StableFXAdapter fxAdapter = new StableFXAdapter(owner);
        console2.log("StableFXAdapter:    ", address(fxAdapter));

        // ── 3. CCTPAdapter ────────────────────────────────────────────────────
        CCTPAdapter cctpAdapter = new CCTPAdapter(owner);
        console2.log("CCTPAdapter:        ", address(cctpAdapter));

        // ── 4. AtomicSettler ──────────────────────────────────────────────────
        AtomicSettler settler = new AtomicSettler(owner, address(fxAdapter));
        console2.log("AtomicSettler:      ", address(settler));

        // ── 5. ConduitRouter ──────────────────────────────────────────────────
        ConduitRouter router = new ConduitRouter(
            owner,
            address(registry),
            address(settler),
            address(fxAdapter)
        );
        console2.log("ConduitRouter:      ", address(router));

        // ── 6. Wire Authorizations ────────────────────────────────────────────
        fxAdapter.setAuthorizedCaller(address(settler), true);
        settler.setAuthorizedRouter(address(router), true);
        cctpAdapter.setAuthorizedCaller(address(router), true);

        console2.log("");
        console2.log("=== Authorizations Set ===");
        console2.log("fxAdapter authorized caller: AtomicSettler");
        console2.log("settler authorized router:   ConduitRouter");
        console2.log("cctpAdapter authorized:      ConduitRouter");

        vm.stopBroadcast();

        // ── Output for .env.local ─────────────────────────────────────────────
        console2.log("");
        console2.log("=== Copy to packages/app/.env.local ===");
        console2.log("NEXT_PUBLIC_CONDUIT_ROUTER=", vm.toString(address(router)));
        console2.log("NEXT_PUBLIC_DECLARATION_REGISTRY=", vm.toString(address(registry)));
        console2.log("NEXT_PUBLIC_STABLEFX_ADAPTER=", vm.toString(address(fxAdapter)));
        console2.log("NEXT_PUBLIC_ATOMIC_SETTLER=", vm.toString(address(settler)));
        console2.log("NEXT_PUBLIC_CCTP_ADAPTER=", vm.toString(address(cctpAdapter)));
    }
}
