// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {DeclarationRegistry} from "../src/DeclarationRegistry.sol";

/// @dev Tests run against Arc Testnet fork (real state, no mocks).
///      Run with: forge test --fork-url https://rpc.testnet.arc.network -vvv
contract DeclarationRegistryTest is Test {
    DeclarationRegistry registry;

    address constant USDC = 0x3600000000000000000000000000000000000000;
    address constant EURC = 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a;
    address constant OWNER = address(0xABC1);
    address constant RECIPIENT = address(0xBEEF);
    address constant OTHER = address(0xDEAD);

    function setUp() public {
        registry = new DeclarationRegistry(OWNER);
    }

    // ── register ──────────────────────────────────────────────────────────────

    function test_register_fixedAmount() public {
        vm.prank(RECIPIENT);
        bytes32 id = registry.register(USDC, 10_000_000); // $10 USDC

        DeclarationRegistry.PaymentDeclaration memory decl = registry.resolve(id);
        assertEq(decl.recipient, RECIPIENT);
        assertEq(decl.recipientToken, USDC);
        assertEq(decl.amount, 10_000_000);
        assertTrue(decl.active);
        assertGt(decl.registeredAt, 0);
    }

    function test_register_openAmount() public {
        vm.prank(RECIPIENT);
        bytes32 id = registry.register(EURC, 0);

        DeclarationRegistry.PaymentDeclaration memory decl = registry.resolve(id);
        assertEq(decl.amount, 0);
        assertTrue(decl.active);
    }

    function test_register_multipleByOneRecipient() public {
        vm.startPrank(RECIPIENT);
        bytes32 id1 = registry.register(USDC, 5_000_000);
        vm.warp(block.timestamp + 1);
        bytes32 id2 = registry.register(EURC, 0);
        vm.stopPrank();

        assertNotEq(id1, id2);

        bytes32[] memory ids = registry.getByRecipient(RECIPIENT);
        assertEq(ids.length, 2);
        assertEq(ids[0], id1);
        assertEq(ids[1], id2);
    }

    function test_register_revertsOnZeroToken() public {
        vm.expectRevert(DeclarationRegistry.ZeroAddress.selector);
        vm.prank(RECIPIENT);
        registry.register(address(0), 1000);
    }

    // ── resolve ───────────────────────────────────────────────────────────────

    function test_resolve_revertsOnUnknownId() public {
        bytes32 unknownId = keccak256("nonexistent");
        vm.expectRevert(
            abi.encodeWithSelector(DeclarationRegistry.DeclarationNotFound.selector, unknownId)
        );
        registry.resolve(unknownId);
    }

    // ── deactivate ────────────────────────────────────────────────────────────

    function test_deactivate_byOwner() public {
        vm.prank(RECIPIENT);
        bytes32 id = registry.register(USDC, 1_000_000);

        vm.prank(RECIPIENT);
        registry.deactivate(id);

        DeclarationRegistry.PaymentDeclaration memory decl = registry.resolve(id);
        assertFalse(decl.active);
    }

    function test_deactivate_revertsIfNotOwner() public {
        vm.prank(RECIPIENT);
        bytes32 id = registry.register(USDC, 1_000_000);

        vm.expectRevert(
            abi.encodeWithSelector(DeclarationRegistry.NotDeclarationOwner.selector, id)
        );
        vm.prank(OTHER);
        registry.deactivate(id);
    }

    function test_isActive() public {
        vm.prank(RECIPIENT);
        bytes32 id = registry.register(USDC, 1_000_000);
        assertTrue(registry.isActive(id));

        vm.prank(RECIPIENT);
        registry.deactivate(id);
        assertFalse(registry.isActive(id));
    }

    // ── fuzz ──────────────────────────────────────────────────────────────────

    function testFuzz_register(uint256 amount) public {
        vm.prank(RECIPIENT);
        bytes32 id = registry.register(USDC, amount);

        DeclarationRegistry.PaymentDeclaration memory decl = registry.resolve(id);
        assertEq(decl.amount, amount);
        assertEq(decl.recipient, RECIPIENT);
    }
}
