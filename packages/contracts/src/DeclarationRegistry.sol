// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title DeclarationRegistry
/// @notice Registry for payment declarations. A declaration is a recipient's
///         expression of intent: "I want X amount of Y token." Anyone holding
///         the declarationId can fulfill it. Set amount = 0 for open amounts.
/// @dev Standalone — no external protocol dependencies.
contract DeclarationRegistry is Ownable {
    // ── Data Structures ───────────────────────────────────────────────────────

    struct PaymentDeclaration {
        address recipient;
        address recipientToken;
        uint256 amount;        // 0 = open amount, 6-decimal ERC-20 units
        uint256 registeredAt;
        bool active;
    }

    // ── State ─────────────────────────────────────────────────────────────────

    mapping(bytes32 => PaymentDeclaration) private _declarations;

    // Track all declaration IDs per address for enumeration
    mapping(address => bytes32[]) private _recipientDeclarations;

    // ── Events ────────────────────────────────────────────────────────────────

    event DeclarationRegistered(
        bytes32 indexed declarationId,
        address indexed recipient,
        address recipientToken,
        uint256 amount
    );

    event DeclarationDeactivated(
        bytes32 indexed declarationId,
        address indexed recipient
    );

    // ── Errors ────────────────────────────────────────────────────────────────

    error DeclarationNotFound(bytes32 declarationId);
    error DeclarationInactive(bytes32 declarationId);
    error NotDeclarationOwner(bytes32 declarationId);
    error ZeroAddress();

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ── External Functions ────────────────────────────────────────────────────

    /// @notice Register a new payment declaration.
    /// @param recipientToken  ERC-20 token the recipient wants (USDC or EURC).
    /// @param amount          Desired amount in 6-decimal units. 0 = open amount.
    /// @return declarationId  Unique identifier derived from recipient + token + amount + nonce.
    function register(
        address recipientToken,
        uint256 amount
    ) external returns (bytes32 declarationId) {
        if (recipientToken == address(0)) revert ZeroAddress();

        declarationId = keccak256(
            abi.encodePacked(
                msg.sender,
                recipientToken,
                amount,
                block.timestamp,
                _recipientDeclarations[msg.sender].length
            )
        );

        _declarations[declarationId] = PaymentDeclaration({
            recipient: msg.sender,
            recipientToken: recipientToken,
            amount: amount,
            registeredAt: block.timestamp,
            active: true
        });

        _recipientDeclarations[msg.sender].push(declarationId);

        emit DeclarationRegistered(declarationId, msg.sender, recipientToken, amount);
    }

    /// @notice Resolve a declaration by its ID.
    /// @dev Reverts if the declaration does not exist.
    function resolve(bytes32 declarationId)
        external
        view
        returns (PaymentDeclaration memory)
    {
        PaymentDeclaration storage decl = _declarations[declarationId];
        if (decl.recipient == address(0)) revert DeclarationNotFound(declarationId);
        return decl;
    }

    /// @notice Deactivate a declaration. Only the original recipient may call.
    function deactivate(bytes32 declarationId) external {
        PaymentDeclaration storage decl = _declarations[declarationId];
        if (decl.recipient == address(0)) revert DeclarationNotFound(declarationId);
        if (decl.recipient != msg.sender) revert NotDeclarationOwner(declarationId);

        decl.active = false;
        emit DeclarationDeactivated(declarationId, msg.sender);
    }

    /// @notice Check whether a declaration is active and ready to be fulfilled.
    function isActive(bytes32 declarationId) external view returns (bool) {
        return _declarations[declarationId].active;
    }

    /// @notice Return all declaration IDs registered by a given recipient.
    function getByRecipient(address recipient)
        external
        view
        returns (bytes32[] memory)
    {
        return _recipientDeclarations[recipient];
    }
}
