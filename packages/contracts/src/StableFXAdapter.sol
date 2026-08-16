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
/// Same-currency: transferDirect (pull tokenIn → push to recipient)
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

    event DirectTransfer(address indexed token, address indexed from, address indexed to, uint256 amount);
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

    // ── Same-currency direct transfer ─────────────────────────────────────────

    function transferDirect(address token, address from, address to, uint256 amount) external {
        if (!authorizedCallers[msg.sender]) revert UnauthorizedCaller(msg.sender);
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();

        IERC20(token).safeTransferFrom(from, to, amount);
        emit DirectTransfer(token, from, to, amount);
    }

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
