// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPermit2SignatureTransfer} from "./interfaces/IFxEscrow.sol";

// ── External interfaces ───────────────────────────────────────────────────────



/// @title StableFXAdapter
/// @notice Handles cross-currency settlement.
///
/// Permit2 path (Circle FxEscrow): submitFXFunding — kept for institutional use.
///
/// An on-chain AMM swap path (swapWithPermit / swapDirect / _doSwap) was
/// removed. Arc has no USDC/EURC pool, so it could never settle a payment, and
/// cross-currency goes through Circle StableFX instead. It was unreachable —
/// nothing in this repo ever called it — while still being deployed, publicly
/// callable, and holding an approval primitive over this contract's balances.
contract StableFXAdapter is Ownable2Step {
    using SafeERC20 for IERC20;

    // ── Constants ─────────────────────────────────────────────────────────────

    address public constant FX_ESCROW = 0x867650F5eAe8df91445971f14d89fd84F0C9a9f8;
    address public constant PERMIT2   = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // ── State ─────────────────────────────────────────────────────────────────

    mapping(address => bool) public authorizedCallers;

    // ── Events ────────────────────────────────────────────────────────────────

    event FXFundingSubmitted(address indexed taker, address indexed token, uint256 amount);
    event CallerAuthorized(address indexed caller, bool authorized);

    // ── Errors ────────────────────────────────────────────────────────────────

    error UnauthorizedCaller(address caller);
    error ZeroAmount();
    error ZeroAddress();

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ── Admin ─────────────────────────────────────────────────────────────────

    function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
        authorizedCallers[caller] = authorized;
        emit CallerAuthorized(caller, authorized);
    }

    // transferDirect was removed.
    //
    // It took an arbitrary `from` and `to` and moved tokens between them, so
    // any authorized caller held a general spending power over every allowance
    // ever granted to this contract -- limited only by who is authorized, not by
    // what the transfer was for. Nothing called it: same-currency settlement
    // goes through AtomicSettler.
    //
    // Unreachable and dangerous is still dangerous; it is deployed, and an
    // authorization added later for some other purpose would have silently
    // carried this with it.

    // ── Cross-currency via Permit2 (Circle FxEscrow — institutional) ─────────

    function submitFXFunding(
        IPermit2SignatureTransfer.PermitTransferFrom calldata permit,
        IPermit2SignatureTransfer.SignatureTransferDetails calldata transferDetails,
        address taker,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external {
        if (!authorizedCallers[msg.sender]) revert UnauthorizedCaller(msg.sender);
        if (permit.permitted.amount == 0) revert ZeroAmount();

        IPermit2SignatureTransfer(PERMIT2).permitWitnessTransferFrom(
            permit,
            transferDetails,
            taker,
            witness,
            witnessTypeString,
            signature
        );

        emit FXFundingSubmitted(taker, permit.permitted.token, permit.permitted.amount);
    }

    // ── View ──────────────────────────────────────────────────────────────────

    function hasPermit2Allowance(address token, address taker, uint256 amount)
        external view returns (bool)
    {
        return IERC20(token).allowance(taker, PERMIT2) >= amount;
    }
}
