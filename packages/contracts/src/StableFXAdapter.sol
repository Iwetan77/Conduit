// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPermit2SignatureTransfer} from "./interfaces/IFxEscrow.sol";

/// @title StableFXAdapter
/// @notice Handles cross-currency settlement via Circle StableFX + Permit2.
///
/// @dev CORRECT ARCHITECTURE — Read before touching this contract.
///
///      FxEscrow (0x867650F5eAe8df91445971f14d89fd84F0C9a9f8) is an ERC-1967 proxy.
///      It does NOT expose a swap() method for external callers.
///      It operates as the SPENDER in a Permit2 PermitWitnessTransferFrom call.
///
///      Cross-currency swap flow:
///        ┌─ OFF-CHAIN (SDK) ───────────────────────────────────────────────────┐
///        │ 1. POST /v1/exchange/stablefx/quotes                               │
///        │    → { quoteId, typedData: { PermitWitnessTransferFrom... } }     │
///        │ 2. Taker signs EIP-712 typed data with wallet                     │
///        │ 3. POST /v1/exchange/stablefx/trades                               │
///        │    → { contractTradeId }                                           │
///        │ 4. POST /v1/exchange/stablefx/signatures/funding/presign           │
///        │    → { typedData: { SingleTradeWitness { id: contractTradeId } } }│
///        │ 5. Taker signs funding typed data                                  │
///        └────────────────────────────────────────────────────────────────────┘
///        ┌─ ON-CHAIN ──────────────────────────────────────────────────────────┐
///        │ 6. Permit2.permitWitnessTransferFrom(                              │
///        │      permit,           // USDC, amount, nonce, deadline            │
///        │      transferDetails,  // to=FxEscrow, requestedAmount             │
///        │      owner,            // taker address                            │
///        │      witness,          // keccak256(SingleTradeWitness)            │
///        │      witnessTypeString,// from Circle API                         │
///        │      signature         // taker's funding signature                │
///        │    )                                                                │
///        │    → Permit2 transfers USDC from taker → FxEscrow                 │
///        │    → FxEscrow delivers EURC from maker → recipient                │
///        └────────────────────────────────────────────────────────────────────┘
///
///      The SDK calls the Circle API and builds the Permit2 calldata.
///      This adapter contract handles:
///        - Same-currency direct transfers (no API needed)
///        - Forwarding pre-built Permit2 funding calldata for cross-currency
///        - Ensuring taker has Permit2 ERC-20 allowance before funding
///
///      Prerequisites for the taker (done once, handled by SDK):
///        USDC.approve(PERMIT2, type(uint256).max)
contract StableFXAdapter is Ownable {
    using SafeERC20 for IERC20;

    // ── Constants ─────────────────────────────────────────────────────────────

    /// @notice Circle StableFX FxEscrow proxy on Arc Testnet.
    address public constant FX_ESCROW = 0x867650F5eAe8df91445971f14d89fd84F0C9a9f8;

    /// @notice Canonical Permit2 — same address across all EVM chains.
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // ── State ─────────────────────────────────────────────────────────────────

    mapping(address => bool) public authorizedCallers;

    // ── Events ────────────────────────────────────────────────────────────────

    event DirectTransfer(
        address indexed token,
        address indexed from,
        address indexed to,
        uint256 amount
    );

    event FXFundingSubmitted(
        address indexed taker,
        address indexed token,
        uint256 amount
    );

    event CallerAuthorized(address indexed caller, bool authorized);

    // ── Errors ────────────────────────────────────────────────────────────────

    error UnauthorizedCaller(address caller);
    error ZeroAmount();
    error ZeroAddress();
    error FundingFailed();

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ── Admin ─────────────────────────────────────────────────────────────────

    function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
        authorizedCallers[caller] = authorized;
        emit CallerAuthorized(caller, authorized);
    }

    // ── External: Same-currency (no API needed) ────────────────────────────────

    /// @notice Direct ERC-20 transfer for same-currency payments.
    /// @dev Called by AtomicSettler for USDC→USDC or EURC→EURC.
    function transferDirect(
        address token,
        address from,
        address to,
        uint256 amount
    ) external {
        if (!authorizedCallers[msg.sender]) revert UnauthorizedCaller(msg.sender);
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();

        IERC20(token).safeTransferFrom(from, to, amount);
        emit DirectTransfer(token, from, to, amount);
    }

    // ── External: Cross-currency via Permit2 + Circle API ─────────────────────

    /// @notice Submit the Permit2 funding transaction for a Circle StableFX trade.
    /// @dev The SDK calls the Circle StableFX API off-chain to get the signed permit
    ///      and witness. This function forwards that data to Permit2 onchain.
    ///      After this call, FxEscrow delivers makerToken to the recipient directly.
    ///
    ///      Called by AtomicSettler (or directly by SDK if routing around the router).
    ///
    /// @param permit           From Circle /quotes response typedData (funding phase).
    /// @param transferDetails  to=FxEscrow, requestedAmount=takerAmount.
    /// @param taker            The taker's wallet address.
    /// @param witness          keccak256(abi.encode(SingleTradeWitness { id: contractTradeId })).
    /// @param witnessTypeString Full EIP-712 type string from Circle API funding presign data.
    /// @param signature        Taker's EIP-712 funding signature.
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

        // Submit Permit2 permitWitnessTransferFrom.
        // Permit2 will transfer takerToken from taker → FxEscrow (transferDetails.to),
        // then FxEscrow settles the maker side → delivers makerToken to recipient.
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

    // ── View: Permit2 allowance check ─────────────────────────────────────────

    /// @notice Check whether a taker has granted Permit2 ERC-20 allowance.
    ///         Taker must call token.approve(PERMIT2, amount) before funding.
    function hasPermit2Allowance(
        address token,
        address taker,
        uint256 amount
    ) external view returns (bool) {
        return IERC20(token).allowance(taker, PERMIT2) >= amount;
    }
}
