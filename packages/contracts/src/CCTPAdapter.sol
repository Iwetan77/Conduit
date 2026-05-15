// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ICCTPTokenMessenger, ICCTPMessageTransmitter} from "./interfaces/ICCTPTokenMessenger.sol";

/// @title CCTPAdapter
/// @notice Wraps CCTP TokenMessengerV2 for cross-chain USDC transfers.
///         v2 interfaces ONLY — never v1.
///
/// @dev Arc Testnet domain is 26.
///      USDC on Arc: 0x3600000000000000000000000000000000000000
///
///      Cross-chain flow:
///        1. Approve TokenMessengerV2 to spend USDC.
///        2. Call depositForBurn — USDC is burned, event emitted.
///        3. Off-chain: poll Circle CCTP Attestation API for signed attestation.
///        4. On destination chain: call MessageTransmitterV2.receiveMessage()
///           with message + attestation — USDC is minted to recipient.
///
///      For Conduit v1, CCTP is available as an escape hatch / future hook.
///      Primary settlement path for Arc→Arc is direct transfer or StableFX.
contract CCTPAdapter is Ownable {
    using SafeERC20 for IERC20;

    // ── Constants ─────────────────────────────────────────────────────────────

    /// @notice CCTP TokenMessengerV2 on Arc Testnet.
    address public constant TOKEN_MESSENGER_V2 = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;

    /// @notice CCTP MessageTransmitterV2 on Arc Testnet.
    address public constant MESSAGE_TRANSMITTER_V2 = 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275;

    /// @notice USDC contract on Arc Testnet (ERC-20, 6 decimals).
    address public constant USDC = 0x3600000000000000000000000000000000000000;

    /// @notice Arc Testnet CCTP domain ID.
    uint32 public constant ARC_DOMAIN = 26;

    /// @notice Fast transfer finality threshold for CCTP v2.
    uint32 public constant FAST_FINALITY_THRESHOLD = 1000;

    // ── State ─────────────────────────────────────────────────────────────────

    mapping(address => bool) public authorizedCallers;

    // ── Events ────────────────────────────────────────────────────────────────

    event CrossChainBurnInitiated(
        uint64 indexed nonce,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        uint256 amount
    );

    event CrossChainReceived(
        address indexed recipient,
        uint256 amount
    );

    event CallerAuthorized(address indexed caller, bool authorized);

    // ── Errors ────────────────────────────────────────────────────────────────

    error UnauthorizedCaller(address caller);
    error UnsupportedToken(address token);
    error ZeroAmount();

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ── Admin ─────────────────────────────────────────────────────────────────

    function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
        authorizedCallers[caller] = authorized;
        emit CallerAuthorized(caller, authorized);
    }

    // ── External Functions ────────────────────────────────────────────────────

    /// @notice Burn USDC on Arc and initiate cross-chain mint on destination.
    /// @dev Caller must have transferred USDC to this contract before calling,
    ///      or this contract must have approval. Uses v2 with fast finality.
    ///
    /// @param amount              USDC amount to bridge (6-decimal units).
    /// @param destinationDomain   CCTP domain ID of the target chain.
    /// @param mintRecipient       Recipient on destination (left-padded bytes32).
    /// @return nonce              CCTP nonce for attestation polling.
    function burnForCrossChain(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient
    ) external returns (uint64 nonce) {
        if (!authorizedCallers[msg.sender]) revert UnauthorizedCaller(msg.sender);
        if (amount == 0) revert ZeroAmount();

        // Approve TokenMessengerV2 to burn our USDC
        IERC20(USDC).approve(TOKEN_MESSENGER_V2, amount);

        nonce = ICCTPTokenMessenger(TOKEN_MESSENGER_V2).depositForBurn(
            amount,
            destinationDomain,
            mintRecipient,
            USDC,
            bytes32(0),          // allow any relayer
            0,                   // maxFee = 0 on testnet
            FAST_FINALITY_THRESHOLD
        );

        emit CrossChainBurnInitiated(nonce, destinationDomain, mintRecipient, amount);
    }

    /// @notice Relay a CCTP message + attestation to mint USDC on this chain.
    /// @dev Anyone can call this — attestation proves the burn happened on source.
    function receiveMessage(
        bytes calldata message,
        bytes calldata attestation
    ) external returns (bool success) {
        success = ICCTPMessageTransmitter(MESSAGE_TRANSMITTER_V2)
            .receiveMessage(message, attestation);
    }

    /// @notice Convert an address to the bytes32 format CCTP expects.
    function addressToBytes32(address addr) external pure returns (bytes32) {
        return bytes32(uint256(uint160(addr)));
    }
}
