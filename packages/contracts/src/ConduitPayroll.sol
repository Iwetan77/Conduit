// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ConduitPayroll
/// @notice Pays a list of people one token, in one transaction.
///
/// @dev Deliberately tiny, and every omission is deliberate too.
///
/// There is no owner, no admin, no upgradeability, no fee logic and no pause.
/// This contract never holds a balance between calls -- it pulls exactly what it
/// is about to send and sends all of it in the same call -- so there is nothing
/// for an admin to rescue and nothing for an upgrade to fix that redeploying
/// would not fix more honestly. Every one of those features would be a key
/// somebody holds over a payroll, which is a liability rather than a safeguard.
///
/// One approve per run, not one per person. The total is pulled once and pushed
/// out individually, which is the difference between a business approving a
/// known figure and approving a contract repeatedly.
///
/// All-or-nothing is the entire point. Half a payroll is worse than none: the
/// people who were paid have been, the people who were not cannot be told when
/// they will be, and there is no state anywhere saying which is which. A revert
/// leaves the run exactly where it started, and it can be run again.
contract ConduitPayroll is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice One payment, for the indexer to tie back to an employee.
    event PayrollPaid(bytes32 indexed runId, address indexed token, address indexed to, uint256 amount);

    /// @notice The run as a whole. Carries the caller's own id so the indexer
    /// can match a transaction to a payroll_runs row without guessing which of
    /// several runs in a block it belongs to.
    event PayrollRun(bytes32 indexed runId, address indexed token, address indexed payer, uint256 recipients, uint256 total);

    error TooManyRecipients();
    error LengthMismatch();
    error NoRecipients();
    error ZeroRecipient();
    error ZeroAmount();
    error FeeOnTransferUnsupported();

    /// @notice The most people one run can pay.
    ///
    /// @dev Derived from Arc's block gas limit, not chosen for roundness. Arc
    ///      reports 30,000,000 per block; the API costs a recipient at 35,000
    ///      gas (`gasPerRecipient` in payroll_runs.go), which puts the
    ///      theoretical ceiling at ~857. This is set to less than half of that.
    ///
    ///      The headroom is the point. 35,000 is an ESTIMATE, a run shares its
    ///      block with other transactions, and the failure mode of getting this
    ///      wrong is the expensive one: the loop is unbounded today, so a large
    ///      roster exceeds the block limit and reverts AFTER the merchant has
    ///      already signed and paid for the approve. A cap that refuses early
    ///      costs a draft; a cap that refuses late costs a signature and a fee.
    ///
    ///      The API enforces the same number when building legs, so an
    ///      over-large roster is refused at draft time rather than at signature
    ///      time. If this changes, that must change with it.
    uint256 public constant MAX_RECIPIENTS = 400;

    /// @notice Send `amounts[i]` of `token` to `to[i]`, for every i.
    /// @param runId Caller-supplied. Echoed in both events so a payroll run can
    ///        be identified on chain; it is not read or enforced here, and
    ///        reusing one is the caller's business.
    /// @dev Reverts unless every recipient is a real address and every amount is
    ///      non-zero, because a zero-value line in a payroll is a mistake
    ///      somebody made rather than a payment somebody intended.
    ///
    ///      Duplicates are NOT rejected. The same address appearing twice is a
    ///      person with two arrangements -- salary and expenses, say -- and
    ///      collapsing them silently would pay one and drop the other. Two lines
    ///      mean two transfers and two events.
    function disperse(
        bytes32 runId,
        address token,
        address[] calldata to,
        uint256[] calldata amounts
    ) external nonReentrant returns (uint256 total) {
        if (to.length != amounts.length) revert LengthMismatch();
        if (to.length == 0) revert NoRecipients();
        if (to.length > MAX_RECIPIENTS) revert TooManyRecipients();

        for (uint256 i = 0; i < to.length; ++i) {
            if (to[i] == address(0)) revert ZeroRecipient();
            if (amounts[i] == 0) revert ZeroAmount();
            total += amounts[i];
        }

        IERC20 erc20 = IERC20(token);

        // Pull once, and check we actually received what we asked for.
        //
        // A fee-on-transfer token delivers less than `total` here, and the
        // pushes below would then run out partway through -- paying the first
        // people in the list in full and reverting on somebody near the end,
        // with the reason looking like an unrelated balance problem. Refusing
        // outright is the honest answer: this contract cannot know whose salary
        // should absorb the fee, and silently under-paying everybody is not a
        // decision it is entitled to make.
        uint256 before = erc20.balanceOf(address(this));
        erc20.safeTransferFrom(msg.sender, address(this), total);
        if (erc20.balanceOf(address(this)) - before != total) revert FeeOnTransferUnsupported();

        for (uint256 i = 0; i < to.length; ++i) {
            erc20.safeTransfer(to[i], amounts[i]);
            emit PayrollPaid(runId, token, to[i], amounts[i]);
        }

        // Everything pulled was paid out.
        //
        // The check above catches a token that takes a fee on the way IN. One
        // that takes a fee on the way OUT passes it and then leaves this
        // contract short before the last recipient, so the run reverts with an
        // opaque "transfer amount exceeds balance" that names neither the cause
        // nor the token. This says which it is.
        //
        // Compared against `before`, NOT against zero. Zero would be the
        // tighter-looking assertion and it would be a permanent griefing
        // vector: anybody could send this contract one unit of a token and
        // every payroll run in that token would revert forever, since a
        // donation is not a balance this contract can spend or refuse. Ending
        // where it started is the property that actually distinguishes a
        // fee-on-transfer token, and it is immune to what strangers do.
        if (erc20.balanceOf(address(this)) != before) revert FeeOnTransferUnsupported();

        emit PayrollRun(runId, token, msg.sender, to.length, total);
    }
}
