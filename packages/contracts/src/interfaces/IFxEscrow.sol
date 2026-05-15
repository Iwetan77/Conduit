// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Circle StableFX FxEscrow — 0x867650F5eAe8df91445971f14d89fd84F0C9a9f8
// This address is an ERC-1967 proxy that delegates to the Circle FxEscrow implementation.
//
// ── Correct Architecture ──────────────────────────────────────────────────────
// The FxEscrow does NOT expose a swap() function that you call directly.
// Instead, it acts as the Permit2 SPENDER in a PermitWitnessTransferFrom flow.
//
// Onchain flow (after Circle StableFX API returns signed typed data):
//   Permit2.permitWitnessTransferFrom(permit, transferDetails, owner, witness, witnessTypeString, sig)
//     └─ Permit2 transfers takerToken from taker → FxEscrow (as spender)
//     └─ FxEscrow delivers makerToken from maker → recipient
//
// Witness types used by Circle StableFX:
//   Consideration { quoteId, base, quote, baseAmount, quoteAmount, maturity }
//   TakerDetails  { consideration, recipient, fee }
//
// The witness hash = keccak256(abi.encode(TakerDetails))
// The witness type string is passed as-is from the Circle API response.
//
// ── Permit2 Interface (the actual onchain call) ───────────────────────────────
// See IPermit2SignatureTransfer below.

// Minimal Permit2 SignatureTransfer interface needed for StableFX taker funding.
interface IPermit2SignatureTransfer {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;       // FxEscrow address — receives takerToken
        uint256 requestedAmount;
    }

    /// @notice Transfer tokens using a signed permit with an arbitrary witness.
    /// @dev Called by the spender (FxEscrow address) on behalf of the owner (taker).
    ///      In practice, the Circle StableFX API submits this OR you submit it directly
    ///      using the typed data returned by the Circle /signatures/funding/presign endpoint.
    ///
    /// @param permit          Token, amount, nonce, deadline
    /// @param transferDetails Destination (FxEscrow) and amount
    /// @param owner           Taker's wallet address
    /// @param witness         keccak256(abi.encode(SingleTradeWitness { id: contractTradeId }))
    /// @param witnessTypeString Full EIP-712 type string from Circle API response
    /// @param signature       Taker EIP-712 signature over the full typed data
    function permitWitnessTransferFrom(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external;
}

// ── StableFX API Data Structures ─────────────────────────────────────────────
// These mirror what the Circle StableFX API returns in its typed data responses.
// Used by the SDK — not on-chain structs.

// Phase 1 — Quote + Trade creation witness (TakerDetails)
// From POST /v1/exchange/stablefx/quotes (type=tradable) response typedData:
//   Consideration { quoteId, base, quote, baseAmount, quoteAmount, maturity }
//   TakerDetails  { consideration, recipient, fee }

// Phase 2 — Funding witness (SingleTradeWitness)
// From POST /v1/exchange/stablefx/signatures/funding/presign response typedData:
//   SingleTradeWitness { id: uint256 }  // contractTradeId from trade creation

// ── FxEscrow Proxy ────────────────────────────────────────────────────────────
// The proxy at 0x867650F5eAe8df91445971f14d89fd84F0C9a9f8 implements ERC-1967.
// Its implementation holds the FxEscrow logic. The Permit2 call with FxEscrow
// as the spender triggers FxEscrow's callback to settle the maker side.
interface IFxEscrowProxy {
    /// @notice ERC-1967: returns current implementation address.
    function implementation() external view returns (address);
}
