// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ConduitPayroll} from "../src/ConduitPayroll.sol";

/// @title DeployPayroll
/// @notice Deploys ConduitPayroll and records its address, touching nothing else.
///
/// @dev Separate from Deploy.s.sol on purpose, and the reason matters.
///
/// Deploy.s.sol redeploys the whole protocol -- registries, adapter, settler and
/// the router -- and overwrites deployments/arc-testnet.json with the new
/// addresses. The router address is live configuration: the API reads it from
/// CONDUIT_ROUTER_ADDRESS to guard token approvals and to verify direct
/// settlements, so replacing it silently breaks paying and recording in
/// production.
///
/// Adding one contract must not cost that. This deploys one contract and MERGES
/// its address into the existing file, leaving every other entry exactly as it
/// was.
///
///   forge script script/DeployPayroll.s.sol --rpc-url arc_testnet --broadcast
contract DeployPayroll is Script {
    uint256 constant ARC_CHAIN_ID = 5042002;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        require(block.chainid == ARC_CHAIN_ID, "DeployPayroll: wrong chain. Expected Arc Testnet 5042002");

        console2.log("=== ConduitPayroll deployment ===");
        console2.log("Deployer:", deployer);

        vm.startBroadcast(deployerKey);
        ConduitPayroll payroll = new ConduitPayroll();
        vm.stopBroadcast();

        console2.log("ConduitPayroll:", address(payroll));

        // Read, amend, write. `vm.writeJson` with a key path edits the file in
        // place rather than replacing it, which is what keeps every other
        // deployed address intact.
        string memory outPath = string.concat(
            vm.projectRoot(),
            "/../../deployments/arc-testnet.json"
        );
        vm.writeJson(vm.toString(address(payroll)), outPath, ".conduitPayroll");
        console2.log("Recorded in", outPath);
    }
}
