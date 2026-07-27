// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CurrencyRegistry} from "../src/CurrencyRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract CurrencyRegistryTest is Test {
    address constant OWNER = address(0x1111);

    CurrencyRegistry registry;
    MockERC20 usdc;
    MockERC20 jpyc18;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        jpyc18 = new MockERC20("JPY Coin", "JPYC", 18);

        vm.prank(OWNER);
        registry = new CurrencyRegistry(OWNER);
    }

    function test_registerCurrency_succeeds() public {
        vm.prank(OWNER);
        registry.registerCurrency("USD", address(usdc), 6);

        CurrencyRegistry.CurrencyInfo memory info = registry.getCurrency("USD");
        assertEq(info.token, address(usdc));
        assertEq(info.decimals, 6);
        assertTrue(info.enabled);
    }

    function test_registerCurrency_18decimals_succeeds() public {
        vm.prank(OWNER);
        registry.registerCurrency("JPY", address(jpyc18), 18);

        CurrencyRegistry.CurrencyInfo memory info = registry.getCurrency("JPY");
        assertEq(info.decimals, 18);
    }

    function test_registerCurrency_revertsOnDecimalsMismatch() public {
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(CurrencyRegistry.DecimalsMismatch.selector, uint8(18), uint8(6)));
        registry.registerCurrency("USD", address(usdc), 18);
    }

    function test_registerCurrency_revertsIfNotOwner() public {
        vm.expectRevert();
        registry.registerCurrency("USD", address(usdc), 6);
    }

    function test_registerCurrency_revertsIfAlreadyRegistered() public {
        vm.startPrank(OWNER);
        registry.registerCurrency("USD", address(usdc), 6);
        vm.expectRevert(abi.encodeWithSelector(CurrencyRegistry.AlreadyRegistered.selector, bytes3("USD")));
        registry.registerCurrency("USD", address(usdc), 6);
        vm.stopPrank();
    }

    function test_setEnabled_disablesLookup() public {
        vm.startPrank(OWNER);
        registry.registerCurrency("USD", address(usdc), 6);
        assertTrue(registry.isEnabled("USD"));

        registry.setEnabled("USD", false);
        assertFalse(registry.isEnabled("USD"));
        vm.stopPrank();
    }

    function test_isEnabledToken() public {
        vm.prank(OWNER);
        registry.registerCurrency("USD", address(usdc), 6);

        assertTrue(registry.isEnabledToken(address(usdc)));
        assertFalse(registry.isEnabledToken(address(jpyc18)));
    }

    function test_allCodes_returnsRegistered() public {
        vm.startPrank(OWNER);
        registry.registerCurrency("USD", address(usdc), 6);
        registry.registerCurrency("JPY", address(jpyc18), 18);
        vm.stopPrank();

        bytes3[] memory codes = registry.allCodes();
        assertEq(codes.length, 2);
    }
}
