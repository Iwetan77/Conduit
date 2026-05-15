// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AtomicSettler} from "../src/AtomicSettler.sol";
import {StableFXAdapter} from "../src/StableFXAdapter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @dev Unit tests for AtomicSettler — direct settlement path (same currency).
///
///      Arc Testnet's USDC uses custom precompiles (0x1800...) that Foundry
///      cannot simulate. Tests use MockERC20 for deterministic unit testing.
///      End-to-end integration is verified by deploying to Arc Testnet.
///
///      Run: forge test --match-contract AtomicSettler -vvv
contract AtomicSettlerTest is Test {
    address constant OWNER  = address(0x1111);
    address constant ROUTER = address(0x2222);

    address PAYER;
    address RECIPIENT;

    MockERC20 usdc;
    MockERC20 eurc;
    StableFXAdapter fxAdapter;
    AtomicSettler settler;

    function setUp() public {
        (PAYER,)     = makeAddrAndKey("payer");
        (RECIPIENT,) = makeAddrAndKey("recipient");

        // Deploy mock tokens (6 decimals, same as real USDC / EURC)
        usdc = new MockERC20("USD Coin",  "USDC", 6);
        eurc = new MockERC20("Euro Coin", "EURC", 6);

        // Deploy protocol contracts
        vm.startPrank(OWNER);
        fxAdapter = new StableFXAdapter(OWNER);
        settler   = new AtomicSettler(OWNER, address(fxAdapter));
        settler.setAuthorizedRouter(ROUTER, true);
        fxAdapter.setAuthorizedCaller(address(settler), true);
        vm.stopPrank();

        // Mint starting balances
        usdc.mint(PAYER, 500 * 1e6); // $500 USDC
    }

    // ── settleDirect ──────────────────────────────────────────────────────────

    function test_settleDirect_transfersTokens() public {
        uint256 amount = 25 * 1e6;

        // Router has already pulled tokens from payer; mint directly to settler
        // to simulate the router's push-before-settle pattern.
        usdc.mint(address(settler), amount);

        uint256 recipientBefore = usdc.balanceOf(RECIPIENT);

        vm.prank(ROUTER);
        uint256 out = settler.settleDirect(address(usdc), PAYER, RECIPIENT, amount);

        assertEq(out, amount);
        assertEq(usdc.balanceOf(RECIPIENT) - recipientBefore, amount);
    }

    function test_settleDirect_revertsIfNotAuthorized() public {
        vm.expectRevert(
            abi.encodeWithSelector(AtomicSettler.UnauthorizedRouter.selector, address(this))
        );
        settler.settleDirect(address(usdc), PAYER, RECIPIENT, 1 * 1e6);
    }

    function test_settleDirect_revertsZeroAmount() public {
        vm.expectRevert(AtomicSettler.ZeroAmount.selector);
        vm.prank(ROUTER);
        settler.settleDirect(address(usdc), PAYER, RECIPIENT, 0);
    }

    function test_settleDirect_revertsZeroRecipient() public {
        vm.expectRevert(AtomicSettler.ZeroAddress.selector);
        vm.prank(ROUTER);
        settler.settleDirect(address(usdc), PAYER, address(0), 1 * 1e6);
    }

    function testFuzz_settleDirect(uint256 amount) public {
        amount = bound(amount, 1, 100 * 1e6);

        // Router pushes tokens into settler before calling settleDirect
        usdc.mint(address(settler), amount);

        vm.prank(ROUTER);
        uint256 out = settler.settleDirect(address(usdc), PAYER, RECIPIENT, amount);
        assertEq(out, amount);
        assertEq(usdc.balanceOf(RECIPIENT), amount);
    }
}
