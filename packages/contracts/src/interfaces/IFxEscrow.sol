// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Circle FxEscrow — verified ABI from Arc testnet explorer
// Proxy:          0x867650F5eAe8df91445971f14d89fd84F0C9a9f8  (ERC-1967)
// Implementation: 0x721eAFa9C1e38DD7fFf81d30ea1a5500b37Cf658
//
// ── Architecture ─────────────────────────────────────────────────────────────
// FxEscrow is a two-party settlement contract. It cannot be called unilaterally
// by the taker alone. Both parties must commit before settlement executes:
//
//   1. recordTrade(taker, takerPermit, maker, makerPermit) → tradeId
//      Both sides provide EIP-712 signed Permit2 data simultaneously.
//      Circle's relayer (0x379c868f...e3) typically submits this on-chain.
//
//   2. takerDeliver(id, permit, sig) — taker funds (payerToken → escrow)
//   3. makerDeliver(id, permit, sig) — maker funds (recipientToken → recipient)
//
// Circle's stablecoinKits API (v1/stablecoinKits/swap) orchestrates all three
// steps and returns ready-to-execute calldata for a Circle Adapter Contract.
// Use swap.ts → callStablecoinKits() rather than calling FxEscrow directly.
//
// ── Permit2 interface used by FxEscrow ───────────────────────────────────────

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
        address to;
        uint256 requestedAmount;
    }

    function permitWitnessTransferFrom(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external;
}

// ── Structs used in recordTrade ───────────────────────────────────────────────

struct Consideration {
    bytes32 quoteId;
    address base;        // payerToken (e.g. USDC)
    address quote;       // recipientToken (e.g. EURC)
    uint256 baseAmount;
    uint256 quoteAmount;
    uint256 maturity;    // unix timestamp deadline
}

struct TakerDetails {
    Consideration consideration;
    address recipient;
    uint256 fee;
}

struct MakerDetails {
    uint256 fee;
}

struct TakerPermitWitnessTransferFrom {
    IPermit2SignatureTransfer.TokenPermissions permitted;
    uint256 nonce;
    uint256 deadline;
    TakerDetails witness;
    bytes signature;
}

struct MakerPermitWitnessTransferFrom {
    IPermit2SignatureTransfer.TokenPermissions permitted;
    uint256 nonce;
    uint256 deadline;
    MakerDetails witness;
    bytes signature;
}

enum TradeStatus   { Pending, Active, Settled, Breached }
enum FundingStatus { Unfunded, Funded }

struct TradeDetails {
    address base;
    address quote;
    address taker;
    address maker;
    address recipient;
    uint256 baseAmount;
    uint256 quoteAmount;
    uint256 takerFee;
    uint256 makerFee;
    uint256 takerRiskBuffer;
    uint256 makerRiskBuffer;
    uint256 maturity;
    TradeStatus status;
    FundingStatus takerFundingStatus;
    FundingStatus makerFundingStatus;
}

// ── IFxEscrow ─────────────────────────────────────────────────────────────────

interface IFxEscrow {
    // EIP-712 type string constants
    function SINGLE_TRADE_WITNESS_TYPE() external view returns (string memory);
    function SINGLE_TRADE_WITNESS_TYPEHASH() external view returns (bytes32);
    function TAKER_DETAILS_WITNESS_TYPE() external view returns (string memory);
    function BATCH_TRADE_WITNESS_TYPE() external view returns (string memory);
    function BATCH_TRADE_WITNESS_TYPEHASH() external view returns (bytes32);
    function MAKER_DETAILS_WITNESS_TYPE() external view returns (string memory);

    /// @notice Record a trade. Requires valid signed permits from both taker and maker.
    ///         Only callable by an authorized relayer (Circle's backend).
    function recordTrade(
        address taker,
        TakerPermitWitnessTransferFrom calldata takerPermit,
        address maker,
        MakerPermitWitnessTransferFrom calldata makerPermit
    ) external returns (uint256 id);

    /// @notice Taker funds: transfers payerToken from taker → escrow via Permit2.
    function takerDeliver(
        uint256 id,
        IPermit2SignatureTransfer.PermitTransferFrom calldata permit,
        bytes calldata signature
    ) external;

    /// @notice Maker funds: transfers recipientToken from maker → recipient via Permit2.
    function makerDeliver(
        uint256 id,
        IPermit2SignatureTransfer.PermitTransferFrom calldata permit,
        bytes calldata signature
    ) external;

    function takerBatchDeliver(
        uint256[] calldata ids,
        IPermit2SignatureTransfer.PermitTransferFrom calldata permit,
        bytes calldata signature
    ) external;

    function makerBatchDeliver(
        uint256[] calldata ids,
        IPermit2SignatureTransfer.PermitTransferFrom calldata permit,
        bytes calldata signature
    ) external;

    function getTradeDetails(uint256 id) external view returns (TradeDetails memory);
    function lastTradeId() external view returns (uint256);
    function relayers(address relayer) external view returns (bool);
    function permit2() external view returns (address);
    function addRelayer(address relayer) external;
    function removeRelayer(address relayer) external;
    function breach(uint256 id) external;
    function batchBreach(uint256[] calldata ids) external;
}
