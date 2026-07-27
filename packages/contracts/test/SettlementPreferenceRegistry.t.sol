// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SettlementPreferenceRegistry} from "../src/SettlementPreferenceRegistry.sol";

contract SettlementPreferenceRegistryTest is Test {
    SettlementPreferenceRegistry registry;
    address alice = address(0xA11CE);
    address tokenA = address(0xAAAA);
    address tokenB = address(0xBBBB);

    function setUp() public {
        registry = new SettlementPreferenceRegistry();
    }

    function test_setPreference() public {
        vm.prank(alice);
        registry.setPreference(tokenA);

        (address token, bool active) = registry.preferenceOf(alice);
        assertEq(token, tokenA);
        assertTrue(active);
    }

    function test_overwritePreference() public {
        vm.startPrank(alice);
        registry.setPreference(tokenA);
        registry.setPreference(tokenB);
        vm.stopPrank();

        (address token,) = registry.preferenceOf(alice);
        assertEq(token, tokenB);
    }

    function test_clearPreference() public {
        vm.startPrank(alice);
        registry.setPreference(tokenA);
        registry.clearPreference();
        vm.stopPrank();

        (address token, bool active) = registry.preferenceOf(alice);
        assertEq(token, address(0));
        assertFalse(active);
    }

    function test_noPreferenceByDefault() public view {
        (, bool active) = registry.preferenceOf(alice);
        assertFalse(active);
    }

    function test_preferenceIsPerAddress_noAdminOverride() public {
        vm.prank(alice);
        registry.setPreference(tokenA);

        // Nobody else can set alice's preference — only msg.sender's own entry is writable.
        address bob = address(0xB0B);
        vm.prank(bob);
        registry.setPreference(tokenB);

        (address aliceToken,) = registry.preferenceOf(alice);
        (address bobToken,) = registry.preferenceOf(bob);
        assertEq(aliceToken, tokenA);
        assertEq(bobToken, tokenB);
    }
}
