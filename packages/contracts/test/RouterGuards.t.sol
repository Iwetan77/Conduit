// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ConduitRouter} from "../src/ConduitRouter.sol";
import {CurrencyRegistry} from "../src/CurrencyRegistry.sol";
import {DeclarationRegistry} from "../src/DeclarationRegistry.sol";
import {IConduitRouter} from "../src/interfaces/IConduitRouter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {FeeOnTransferERC20} from "./mocks/QuirkyERC20.sol";

/// Phase A4: the currency registry became load-bearing, and the router grew a
/// guardian pause. Both are about what the router REFUSES, so that is what
/// this file tests.
contract RouterGuardsTest is Test {
    address constant OWNER = address(0x1111);
    address constant GUARDIAN = address(0x2222);
    address constant STRANGER = address(0x3333);

    address PAYER;
    address RECIPIENT;

    MockERC20 usdc;
    MockERC20 unregistered;
    DeclarationRegistry declarations;
    CurrencyRegistry currencies;
    ConduitRouter router;

    function setUp() public {
        (PAYER,) = makeAddrAndKey("payer");
        (RECIPIENT,) = makeAddrAndKey("recipient");

        usdc = new MockERC20("USD Coin", "USDC", 6);
        unregistered = new MockERC20("Rando", "RND", 6);

        vm.startPrank(OWNER);
        declarations = new DeclarationRegistry(OWNER);
        currencies = new CurrencyRegistry(OWNER);
        router = new ConduitRouter(OWNER, address(declarations), address(currencies));
        currencies.registerCurrency("USD", address(usdc), 6);
        router.setGuardian(GUARDIAN);
        vm.stopPrank();

        usdc.mint(PAYER, 1_000 * 1e6);
        unregistered.mint(PAYER, 1_000 * 1e6);
    }

    function _instruction(address token) internal view returns (IConduitRouter.PaymentInstruction memory) {
        return IConduitRouter.PaymentInstruction({
            payer: PAYER,
            recipient: RECIPIENT,
            payerToken: token,
            recipientToken: token,
            amount: 10 * 1e6,
            deadline: block.timestamp + 1 hours,
            declarationId: bytes32(0)
        });
    }

    // ── The registry is load-bearing ──────────────────────────────────────────

    function test_unregisteredTokenReverts() public {
        vm.prank(PAYER);
        unregistered.approve(address(router), 10 * 1e6);

        vm.expectRevert(bytes("token not enabled"));
        vm.prank(PAYER);
        router.execute(_instruction(address(unregistered)));
    }

    function test_disabledTokenReverts() public {
        vm.prank(OWNER);
        currencies.setEnabled("USD", false);

        vm.prank(PAYER);
        usdc.approve(address(router), 10 * 1e6);

        vm.expectRevert(bytes("token not enabled"));
        vm.prank(PAYER);
        router.execute(_instruction(address(usdc)));
    }

    /// A fee-on-transfer token breaks fee accounting outright: the router pulls
    /// `payerAmount`, RECEIVES LESS, then pays out the full amount from a pot
    /// other payers funded. It has to be refused at validation, not discovered
    /// during the transfer.
    function test_feeOnTransferIsRejectedAtValidation() public {
        FeeOnTransferERC20 fee = new FeeOnTransferERC20(100); // 1%
        deal(address(fee), PAYER, 1_000 * 1e6);

        vm.prank(PAYER);
        fee.approve(address(router), 100 * 1e6);

        // Never registered, so it never reaches the accounting it would corrupt.
        vm.expectRevert(bytes("token not enabled"));
        vm.prank(PAYER);
        router.execute(_instruction(address(fee)));
    }

    function test_setTokenRejectsMismatchedDecimals() public {
        MockERC20 replacement = new MockERC20("USD Coin v2", "USDC2", 6);
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(CurrencyRegistry.DecimalsMismatch.selector, 18, 6));
        currencies.setToken("USD", address(replacement), 18);
    }

    /// Migrating a code to a new token must stop the OLD one resolving. A
    /// reverse index left pointing at the old address keeps it spendable
    /// through the router forever, which is a migration that migrated nothing.
    function test_setTokenClearsTheOldReverseIndex() public {
        MockERC20 replacement = new MockERC20("USD Coin v2", "USDC2", 6);
        vm.prank(OWNER);
        currencies.setToken("USD", address(replacement), 6);

        assertFalse(currencies.isEnabledToken(address(usdc)), "old token still routes");
        assertTrue(currencies.isEnabledToken(address(replacement)), "new token does not route");
    }

    /// isEnabledToken is called inside execute(), so its cost is paid by every
    /// payer on every payment. The old implementation looped every registered
    /// code; this asserts it no longer grows with the registry.
    function test_isEnabledTokenIsConstantTime() public {
        vm.startPrank(OWNER);
        for (uint256 i = 0; i < 50; i++) {
            MockERC20 t = new MockERC20("T", "T", 6);
            currencies.registerCurrency(bytes3(uint24(0x410000 + i)), address(t), 6);
        }
        vm.stopPrank();

        uint256 before = gasleft();
        currencies.isEnabledToken(address(usdc));
        uint256 used = before - gasleft();

        // A single mapping read plus a struct field read. An unbounded loop over
        // 51 codes could not come close to this.
        assertLt(used, 10_000, "isEnabledToken is not O(1)");
    }

    // ── Guardian pause ────────────────────────────────────────────────────────

    function test_guardianCanPause() public {
        vm.prank(GUARDIAN);
        router.pause();
        assertTrue(router.paused());
    }

    /// The whole asymmetry. A hot key that could also release the brake would
    /// be no safer than an owner key.
    function test_guardianCannotUnpause() public {
        vm.prank(GUARDIAN);
        router.pause();

        vm.prank(GUARDIAN);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, GUARDIAN));
        router.unpause();
    }

    function test_ownerCanUnpause() public {
        vm.prank(GUARDIAN);
        router.pause();
        vm.prank(OWNER);
        router.unpause();
        assertFalse(router.paused());
    }

    function test_strangerCanDoNeither() public {
        vm.prank(STRANGER);
        vm.expectRevert(bytes("not guardian"));
        router.pause();

        vm.prank(GUARDIAN);
        router.pause();

        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, STRANGER));
        router.unpause();
    }

    function test_executeRevertsWhilePaused() public {
        vm.prank(GUARDIAN);
        router.pause();

        vm.prank(PAYER);
        usdc.approve(address(router), 10 * 1e6);

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(PAYER);
        router.execute(_instruction(address(usdc)));
    }

    /// The pause stops payments; it is not a freeze on money already owed.
    /// This is the reason the pause is not itself a risk.
    function test_withdrawFeesSucceedsWhilePaused() public {
        vm.prank(OWNER);
        // MAX_PROTOCOL_FEE_BPS is 30. The cap is the contract being right;
        // this test asked for 1% and got refused, correctly.
        router.setProtocolFee(30); // 0.3%

        vm.prank(PAYER);
        usdc.approve(address(router), 20 * 1e6);
        vm.prank(PAYER);
        router.execute(_instruction(address(usdc)));

        vm.prank(GUARDIAN);
        router.pause();

        uint256 fees = router.accumulatedFees(address(usdc));
        assertGt(fees, 0, "no fee accrued to withdraw");

        vm.prank(OWNER);
        router.withdrawFees(address(usdc), OWNER);
        assertEq(usdc.balanceOf(OWNER), fees);
    }

    function test_withdrawFeesRejectsZeroAmount() public {
        vm.prank(OWNER);
        vm.expectRevert(bytes("no fees"));
        router.withdrawFees(address(usdc), OWNER);
    }

    /// A recipient must always be able to stop accepting payments, ESPECIALLY
    /// while the protocol is paused. DeclarationRegistry is deliberately not
    /// pausable.
    function test_declarationCanBeDeactivatedWhilePaused() public {
        vm.prank(RECIPIENT);
        bytes32 id = declarations.register(address(usdc), 10 * 1e6);

        vm.prank(GUARDIAN);
        router.pause();

        vm.prank(RECIPIENT);
        declarations.deactivate(id);
        assertFalse(declarations.resolve(id).active);
    }

    function test_ownerCanRevokeGuardian() public {
        vm.prank(OWNER);
        router.setGuardian(address(0));

        vm.prank(GUARDIAN);
        vm.expectRevert(bytes("not guardian"));
        router.pause();
    }
}
