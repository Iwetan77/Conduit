// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPermit2SignatureTransfer} from "./interfaces/IFxEscrow.sol";

/// @title StableFXAdapter
/// @notice Handles cross-currency settlement via Circle StableFX + Permit2.
///
/// @dev Architecture (verified from Arc testnet contract ABIs):
///
///      FxEscrow (0x867650F5eAe8df91445971f14d89fd84F0C9a9f8) is a two-party
///      settlement contract. It requires BOTH taker and maker signed permits to
///      record a trade. Circle's authorised relayer submits recordTrade on-chain.
///
///      The SDK (swap.ts) calls Circle's stablecoinKits API server-side:
///        POST /v1/stablecoinKits/swap
///        → returns calldata for Circle's Adapter Contract
///        → browser approves tokenIn to Adapter Contract, submits calldata
///        → Adapter Contract pulls tokenIn via ERC-20 approve, calls FxEscrow
///        → FxEscrow settles both sides atomically
///
///      This contract (StableFXAdapter) is the Conduit-side on-chain component.
///      It forwards pre-built Permit2 funding calldata assembled by the SDK
///      directly to Permit2, enforcing Conduit access control and emitting events.
contract StableFXAdapter is Ownable {
    using SafeERC20 for IERC20;

    // ── Constants ─────────────────────────────────────────────────────────────

    /// @notice Circle FxEscrow proxy on Arc Testnet.
    address public constant FX_ESCROW = 0x867650F5eAe8df91445971f14d89fd84F0C9a9f8;

    /// @notice Canonical Permit2 — same address across all EVM chains.
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

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

    /// @notice Direct ERC-20 transfer for same-currency payments (USDC→USDC, EURC→EURC).
    function transferDirect(address token, address from, address to, uint256 amount) external {
        if (!authorizedCallers[msg.sender]) revert UnauthorizedCaller(msg.sender);
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();

        IERC20(token).safeTransferFrom(from, to, amount);
        emit DirectTransfer(token, from, to, amount);
    }

    // ── Cross-currency via Permit2 ────────────────────────────────────────────

    /// @notice Submit Permit2 funding for a Circle StableFX trade.
    ///
    /// @dev SDK obtains permit + witness + signature from Circle's stablecoinKits
    ///      API. Permit2 transfers takerToken from taker → FxEscrow, then FxEscrow
    ///      delivers makerToken to the recipient atomically.
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
