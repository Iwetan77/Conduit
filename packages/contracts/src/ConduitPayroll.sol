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

    error LengthMismatch();
    error NoRecipients();
    error ZeroRecipient();
    error ZeroAmount();
    error FeeOnTransferUnsupported();

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

        emit PayrollRun(runId, token, msg.sender, to.length, total);
    }
}
