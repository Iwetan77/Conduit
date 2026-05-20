// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPermit2SignatureTransfer} from "./interfaces/IFxEscrow.sol";

// ── External interfaces ───────────────────────────────────────────────────────

interface IERC20Permit {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
    function nonces(address owner) external view returns (uint256);
}

interface IUniswapV2Router {
    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/// @title StableFXAdapter
/// @notice Handles cross-currency settlement.
///
/// Same-currency: transferDirect (pull tokenIn → push to recipient)
/// Cross-currency via AMM: swapWithPermit / swapDirect
///   swapWithPermit — first use: accepts an EIP-2612 permit signature so the
///     spending approval and the swap happen in one transaction (no separate
///     approve tx). Sets MaxUint256 allowance so subsequent swaps are free of
///     any approval step.
///   swapDirect — subsequent use: allowance already MaxUint256, just swap.
///
/// Permit2 path (Circle FxEscrow): submitFXFunding — kept for institutional use.
contract StableFXAdapter is Ownable {
    using SafeERC20 for IERC20;

    // ── Constants ─────────────────────────────────────────────────────────────

    address public constant FX_ESCROW = 0x867650F5eAe8df91445971f14d89fd84F0C9a9f8;
    address public constant PERMIT2   = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // ── State ─────────────────────────────────────────────────────────────────

    mapping(address => bool) public authorizedCallers;

    // ── Events ────────────────────────────────────────────────────────────────

    event DirectTransfer(address indexed token, address indexed from, address indexed to, uint256 amount);
    event FXFundingSubmitted(address indexed taker, address indexed token, uint256 amount);
    event SwapExecuted(address indexed tokenIn, address indexed tokenOut, address indexed user, uint256 amountIn, uint256 amountOut);
    event CallerAuthorized(address indexed caller, bool authorized);

    // ── Errors ────────────────────────────────────────────────────────────────

    error UnauthorizedCaller(address caller);
    error ZeroAmount();
    error ZeroAddress();
    error SlippageExceeded(uint256 required, uint256 maxAllowed);

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

    // ── Cross-currency via AMM — first use (EIP-2612 permit) ─────────────────

    /// @notice Swap tokenIn for an exact amountOut of tokenOut using an EIP-2612
    ///         permit to set the spending allowance in the same transaction.
    ///         Sets MaxUint256 so all future calls skip the permit step.
    ///
    /// @param tokenIn       Token the caller pays with.
    /// @param permitDeadline Unix timestamp after which the permit is invalid.
    /// @param v r s         EIP-2612 permit signature components.
    /// @param tokenOut      Token the caller receives.
    /// @param amountOut     Exact amount of tokenOut the caller must receive.
    /// @param amountInMax   Maximum tokenIn the caller is willing to spend (slippage cap).
    /// @param router        Uniswap V2-compatible AMM router address.
    /// @param swapDeadline  Unix timestamp after which the swap reverts.
    function swapWithPermit(
        address tokenIn,
        uint256 permitDeadline,
        uint8 v, bytes32 r, bytes32 s,
        address tokenOut,
        uint256 amountOut,
        uint256 amountInMax,
        address router,
        uint256 swapDeadline
    ) external {
        if (amountOut == 0) revert ZeroAmount();

        // Set MaxUint256 allowance via off-chain EIP-2612 signature — no separate approve tx.
        IERC20Permit(tokenIn).permit(
            msg.sender, address(this), type(uint256).max, permitDeadline, v, r, s
        );

        _doSwap(tokenIn, tokenOut, amountOut, amountInMax, router, swapDeadline);
    }

    // ── Cross-currency via AMM — subsequent use (no permit) ──────────────────

    /// @notice Swap tokenIn for an exact amountOut using an existing MaxUint256
    ///         allowance. Called on all payments after the first permit was set.
    function swapDirect(
        address tokenIn,
        address tokenOut,
        uint256 amountOut,
        uint256 amountInMax,
        address router,
        uint256 swapDeadline
    ) external {
        if (amountOut == 0) revert ZeroAmount();
        _doSwap(tokenIn, tokenOut, amountOut, amountInMax, router, swapDeadline);
    }

    // ── Internal swap logic ───────────────────────────────────────────────────

    function _doSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountOut,
        uint256 amountInMax,
        address router,
        uint256 swapDeadline
    ) internal {
        // Pull the maximum tokenIn from the caller
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountInMax);

        // Approve the AMM router — internal to this contract, no user signature
        IERC20(tokenIn).approve(router, amountInMax);

        // Execute exact-output swap; output goes directly to caller
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        uint256[] memory amounts = IUniswapV2Router(router).swapTokensForExactTokens(
            amountOut,
            amountInMax,
            path,
            msg.sender,
            swapDeadline
        );

        uint256 actualIn = amounts[0];
        if (actualIn > amountInMax) revert SlippageExceeded(actualIn, amountInMax);

        // Return any unused tokenIn to the caller
        uint256 leftover = amountInMax - actualIn;
        if (leftover > 0) {
            IERC20(tokenIn).safeTransfer(msg.sender, leftover);
        }

        // Zero out router allowance — defence-in-depth
        IERC20(tokenIn).approve(router, 0);

        emit SwapExecuted(tokenIn, tokenOut, msg.sender, actualIn, amountOut);
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
