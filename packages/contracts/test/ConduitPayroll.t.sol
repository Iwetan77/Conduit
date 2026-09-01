// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {ConduitPayroll} from "../src/ConduitPayroll.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {OutboundFeeERC20} from "./mocks/QuirkyERC20.sol";
import {FeeOnTransferERC20, BlocklistERC20, ReentrantERC20} from "./mocks/QuirkyERC20.sol";

/// @dev What a payroll contract has to get right.
///
/// The one property everything else serves: all-or-nothing. Half a payroll is
/// worse than none -- the people paid have been, the people not paid cannot be
/// told when they will be, and nothing anywhere records which is which.
contract ConduitPayrollTest is Test {
    ConduitPayroll payroll;
    MockERC20 token;

    address payer = address(0xBEEF);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA401);

    bytes32 constant RUN = keccak256("pr_test");

    function setUp() public {
        payroll = new ConduitPayroll();
        token = new MockERC20("USD Coin", "USDC", 6);
        token.mint(payer, 1_000_000e6);
        vm.prank(payer);
        token.approve(address(payroll), type(uint256).max);
    }

    function _to3() internal view returns (address[] memory to) {
        to = new address[](3);
        (to[0], to[1], to[2]) = (alice, bob, carol);
    }

    function _amounts3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory amounts) {
        amounts = new uint256[](3);
        (amounts[0], amounts[1], amounts[2]) = (a, b, c);
    }

    function test_paysEveryoneExactly() public {
        vm.prank(payer);
        uint256 total = payroll.disperse(RUN, address(token), _to3(), _amounts3(100e6, 250e6, 33e6));

        assertEq(total, 383e6, "returned total");
        assertEq(token.balanceOf(alice), 100e6);
        assertEq(token.balanceOf(bob), 250e6);
        assertEq(token.balanceOf(carol), 33e6);
        // Nothing is left behind. The contract holds no balance between calls,
        // which is why it needs no owner and no rescue function.
        assertEq(token.balanceOf(address(payroll)), 0, "contract kept funds");
    }

    /// The run id is what ties a transaction back to a payroll_runs row. If it
    /// were not on the event, the indexer would have to guess which of several
    /// runs in a block a transfer belonged to.
    function test_emitsTheRunIdOnEveryEvent() public {
        address[] memory to = _to3();
        uint256[] memory amounts = _amounts3(1e6, 2e6, 3e6);

        vm.recordLogs();
        vm.prank(payer);
        payroll.disperse(RUN, address(token), to, amounts);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 paidEvents;
        uint256 runEvents;
        bytes32 paidSig = keccak256("PayrollPaid(bytes32,address,address,uint256)");
        bytes32 runSig = keccak256("PayrollRun(bytes32,address,address,uint256,uint256)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == paidSig) {
                assertEq(logs[i].topics[1], RUN, "PayrollPaid carries the wrong run id");
                paidEvents++;
            } else if (logs[i].topics[0] == runSig) {
                assertEq(logs[i].topics[1], RUN, "PayrollRun carries the wrong run id");
                runEvents++;
            }
        }
        assertEq(paidEvents, 3, "one event per recipient");
        assertEq(runEvents, 1, "one event per run");
    }

    function test_revertsOnLengthMismatch() public {
        address[] memory to = _to3();
        uint256[] memory amounts = new uint256[](2);
        (amounts[0], amounts[1]) = (1e6, 2e6);

        vm.prank(payer);
        vm.expectRevert(ConduitPayroll.LengthMismatch.selector);
        payroll.disperse(RUN, address(token), to, amounts);
    }

    function test_revertsOnEmptyRun() public {
        vm.prank(payer);
        vm.expectRevert(ConduitPayroll.NoRecipients.selector);
        payroll.disperse(RUN, address(token), new address[](0), new uint256[](0));
    }

    /// A zero address in a payroll is a mistake somebody made, not a payment
    /// somebody intended -- and the money would be gone.
    function test_revertsOnZeroRecipient() public {
        address[] memory to = _to3();
        to[1] = address(0);

        vm.prank(payer);
        vm.expectRevert(ConduitPayroll.ZeroRecipient.selector);
        payroll.disperse(RUN, address(token), to, _amounts3(1e6, 2e6, 3e6));
    }

    function test_revertsOnZeroAmount() public {
        vm.prank(payer);
        vm.expectRevert(ConduitPayroll.ZeroAmount.selector);
        payroll.disperse(RUN, address(token), _to3(), _amounts3(1e6, 0, 3e6));
    }

    /// Nobody is paid when the allowance is short. This is the all-or-nothing
    /// property at its most ordinary: a business that approved too little must
    /// not discover it halfway down the list.
    function test_insufficientAllowancePaysNobody() public {
        vm.prank(payer);
        token.approve(address(payroll), 10e6);

        vm.prank(payer);
        vm.expectRevert();
        payroll.disperse(RUN, address(token), _to3(), _amounts3(100e6, 250e6, 33e6));

        assertEq(token.balanceOf(alice), 0);
        assertEq(token.balanceOf(bob), 0);
        assertEq(token.balanceOf(carol), 0);
    }

    /// The realistic "recipient rejects the payment": an ordinary ERC-20 calls
    /// no hook on the recipient, so the recipient cannot refuse -- but the token
    /// can, and USDC's blocklist does exactly this.
    function test_aBlockedRecipientPaysNobody() public {
        BlocklistERC20 blocking = new BlocklistERC20(carol);
        blocking.mint(payer, 1_000e6);
        vm.prank(payer);
        blocking.approve(address(payroll), type(uint256).max);

        vm.prank(payer);
        vm.expectRevert();
        payroll.disperse(RUN, address(blocking), _to3(), _amounts3(1e6, 2e6, 3e6));

        // Alice is first in the list and would have been paid before the failure
        // reached Carol. She has not been.
        assertEq(blocking.balanceOf(alice), 0, "a failed run paid somebody");
        assertEq(blocking.balanceOf(bob), 0);
    }

    /// The same address twice is a person with two arrangements -- salary and
    /// expenses, say. Collapsing them silently would pay one and drop the other.
    function test_duplicateRecipientsAreBothPaid() public {
        address[] memory to = new address[](3);
        (to[0], to[1], to[2]) = (alice, bob, alice);

        vm.prank(payer);
        payroll.disperse(RUN, address(token), to, _amounts3(100e6, 50e6, 25e6));

        assertEq(token.balanceOf(alice), 125e6, "both of one person's lines must be paid");
        assertEq(token.balanceOf(bob), 50e6);
    }

    /// A fee-on-transfer token delivers less than was pulled, so the pushes
    /// would run out near the end of the list. Refusing is the honest answer:
    /// this contract cannot decide whose salary absorbs the fee.
    function test_feeOnTransferIsRefusedRatherThanUnderpaying() public {
        FeeOnTransferERC20 fee = new FeeOnTransferERC20(100); // 1%
        fee.mint(payer, 1_000e6);
        vm.prank(payer);
        fee.approve(address(payroll), type(uint256).max);

        vm.prank(payer);
        vm.expectRevert(ConduitPayroll.FeeOnTransferUnsupported.selector);
        payroll.disperse(RUN, address(fee), _to3(), _amounts3(100e6, 100e6, 100e6));

        assertEq(fee.balanceOf(alice), 0, "somebody was paid out of a refused run");
    }

    /// The token calls back mid-transfer. The guard is what stops a second run
    /// starting inside the first one's push loop.
    function test_reentrancyIsRefused() public {
        ReentrantERC20 evil = new ReentrantERC20();
        evil.mint(payer, 1_000e6);
        vm.prank(payer);
        evil.approve(address(payroll), type(uint256).max);

        address[] memory to = _to3();
        uint256[] memory amounts = _amounts3(1e6, 2e6, 3e6);
        evil.arm(
            address(payroll),
            abi.encodeCall(ConduitPayroll.disperse, (RUN, address(evil), to, amounts))
        );

        // The outer call still succeeds; what must not happen is the inner one
        // paying anybody a second time.
        vm.prank(payer);
        payroll.disperse(RUN, address(evil), to, amounts);

        assertEq(evil.balanceOf(alice), 1e6, "re-entry paid alice twice");
        assertEq(evil.balanceOf(bob), 2e6);
        assertEq(evil.balanceOf(carol), 3e6);
    }

    /// A real payroll is not three people. This is the gas figure, measured
    /// rather than assumed, so a run that will not fit in a block is known
    /// before somebody tries it on a Friday afternoon.
    function test_gasForAHundredRecipients() public {
        uint256 n = 120;
        address[] memory to = new address[](n);
        uint256[] memory amounts = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            to[i] = address(uint160(0x1000 + i));
            amounts[i] = 1e6;
        }

        vm.prank(payer);
        uint256 before = gasleft();
        payroll.disperse(RUN, address(token), to, amounts);
        uint256 used = before - gasleft();

        emit log_named_uint("gas for 120 recipients", used);
        emit log_named_uint("gas per recipient", used / n);
        for (uint256 i = 0; i < n; i++) {
            assertEq(token.balanceOf(to[i]), 1e6, "a recipient was missed");
        }
        // Arc's block gas limit is far above this; the assertion exists so a
        // change that made each line dramatically more expensive is noticed
        // here rather than in production.
        assertLt(used, 8_000_000, "a 120-person run got expensive");
    }

    // ── Phase A5 ──────────────────────────────────────────────────────────────

    function _roster(uint256 n) internal pure returns (address[] memory to, uint256[] memory amounts) {
        to = new address[](n);
        amounts = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            to[i] = address(uint160(0x10000 + i));
            amounts[i] = 1e6;
        }
    }

    /// The loop was unbounded, so a large roster exceeded the block gas limit
    /// and reverted AFTER the merchant had signed and paid for the approve.
    function test_revertsOneOverTheRecipientCap() public {
        uint256 cap = payroll.MAX_RECIPIENTS();
        (address[] memory to, uint256[] memory amounts) = _roster(cap + 1);
        vm.prank(payer);
        vm.expectRevert(ConduitPayroll.TooManyRecipients.selector);
        payroll.disperse(RUN, address(token), to, amounts);
    }

    function test_succeedsExactlyAtTheCap() public {
        uint256 cap = payroll.MAX_RECIPIENTS();
        (address[] memory to, uint256[] memory amounts) = _roster(cap);
        vm.prank(payer);
        uint256 total = payroll.disperse(RUN, address(token), to, amounts);
        assertEq(total, cap * 1e6);
        assertEq(token.balanceOf(address(payroll)), 0, "contract kept funds");
    }

    /// Everything pulled must have been paid out. A token that charges the
    /// sender on top leaves the contract short, and without this the run either
    /// reverts with the token's own opaque balance error or -- if a stray
    /// donation absorbed the difference -- completes while holding less than it
    /// started with.
    function test_outboundFeeRevertsWithItsOwnReason() public {
        OutboundFeeERC20 out = new OutboundFeeERC20(1e6);
        out.setTaxed(address(payroll));
        out.mint(payer, 1_000e6);
        // A donation, which is what makes the loop survivable long enough to
        // reach the post-loop assertion rather than reverting inside it.
        out.mint(address(payroll), 100e6);

        vm.prank(payer);
        out.approve(address(payroll), type(uint256).max);

        vm.prank(payer);
        vm.expectRevert(ConduitPayroll.FeeOnTransferUnsupported.selector);
        payroll.disperse(RUN, address(out), _to3(), _amounts3(1e6, 1e6, 1e6));
    }

    /// The post-loop check compares against the starting balance, not zero.
    /// Zero would let anybody brick payroll for a token forever by sending this
    /// contract one unit of it.
    function test_aDonationDoesNotBrickPayroll() public {
        token.mint(address(payroll), 1);

        vm.prank(payer);
        uint256 total = payroll.disperse(RUN, address(token), _to3(), _amounts3(1e6, 2e6, 3e6));

        assertEq(total, 6e6);
        assertEq(token.balanceOf(alice), 1e6);
        // The donation is still sitting there, untouched and harmless.
        assertEq(token.balanceOf(address(payroll)), 1);
    }
}
