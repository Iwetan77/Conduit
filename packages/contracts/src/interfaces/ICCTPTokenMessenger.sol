// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Circle CCTP TokenMessengerV2 — 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA
// Arc Testnet Domain: 26
// V2 ONLY — never use v1 interfaces on Arc.
interface ICCTPTokenMessenger {
    // ── Events ───────────────────────────────────────────────────────────────

    event DepositForBurn(
        uint64 indexed nonce,
        address indexed burnToken,
        uint256 amount,
        address indexed depositor,
        bytes32 mintRecipient,
        uint32 destinationDomain,
        bytes32 destinationTokenMessenger,
        bytes32 destinationCaller
    );

    // ── Core Functions ────────────────────────────────────────────────────────

    /// @notice Burn USDC on this domain, mint on the destination.
    /// @dev Caller must have approved this contract to spend `amount` of burnToken.
    ///      Use v2 parameters. destinationCaller = bytes32(0) allows any relayer.
    ///      maxFee = 0 for testnet. minFinalityThreshold = 1000 for fast finality.
    /// @param amount                  Amount to burn (6-decimal ERC-20 units).
    /// @param destinationDomain       Target CCTP domain ID. Arc = 26.
    /// @param mintRecipient           Recipient address on destination (padded to bytes32).
    /// @param burnToken               ERC-20 token to burn (must be USDC on Arc).
    /// @param destinationCaller       If non-zero, only this address may relay. Use bytes32(0).
    /// @param maxFee                  Maximum fee deducted from amount. Use 0 on testnet.
    /// @param minFinalityThreshold    Minimum finality score before message is relayable.
    ///                                1000 = fast transfer. 2000 = finalized.
    /// @return nonce  Unique nonce for this burn event, needed for message assembly.
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external returns (uint64 nonce);

    /// @notice Burn with a specific caller restriction (convenience overload).
    function depositForBurnWithCaller(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external returns (uint64 nonce);

    /// @notice Returns the local message transmitter contract address.
    function localMessageTransmitter() external view returns (address);

    /// @notice Returns the local minter contract address.
    function localMinter() external view returns (address);
}

// Circle CCTP MessageTransmitterV2 — 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275
interface ICCTPMessageTransmitter {
    /// @notice Relay a CCTP message and attestation to mint tokens on this domain.
    function receiveMessage(
        bytes calldata message,
        bytes calldata attestation
    ) external returns (bool success);

    /// @notice Returns the local domain ID.
    function localDomain() external view returns (uint32);
}
