// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IConduitRouter
/// @notice The single execution surface for all Conduit payments.
///         Money enters, routes, and exits atomically — payer's currency in,
///         recipient's currency out, in under a second.
interface IConduitRouter {
    // ── Data Structures ───────────────────────────────────────────────────────

    /// @notice A fully-resolved payment instruction ready for on-chain settlement.
    /// @dev All token amounts use 6-decimal ERC-20 units (USDC/EURC). Never mix
    ///      with the 18-decimal native gas representation.
    struct PaymentInstruction {
        address payer;           // wallet signing and funding the payment
        address recipient;       // final beneficiary
        address payerToken;      // ERC-20 the payer holds (USDC or EURC)
        address recipientToken;  // ERC-20 the recipient wants (USDC or EURC)
        uint256 amount;          // desired amount in recipientToken units
        uint256 deadline;        // unix timestamp — quote expiry
        bytes32 declarationId;   // bytes32(0) for direct sends
    }

    // ── Events ────────────────────────────────────────────────────────────────

    /// @notice Emitted on every successful payment, whether direct or via declaration.
    event PaymentSettled(
        bytes32 indexed receiptId,
        address indexed payer,
        address indexed recipient,
        address payerToken,
        address recipientToken,
        uint256 payerAmount,
        uint256 recipientAmount,
        bytes32 declarationId,
        uint256 settledAt
    );

    event DeclarationRegistrySet(address indexed registry);
    event SettlementPreferenceRegistrySet(address indexed registry);
    /// @notice Emitted when the protocol fee changes. Every other admin action
    ///         announced itself; a fee change — the one that alters what every
    ///         payer is charged — did not, so it was invisible to any indexer.
    event ProtocolFeeSet(uint256 bps);
    /// @notice Emitted when accumulated fees are withdrawn.
    event FeesWithdrawn(address indexed token, address indexed to, uint256 amount);

    // ── Core Functions ────────────────────────────────────────────────────────

    /// @notice Execute a same-currency payment (USDC→USDC or EURC→EURC).
    /// @dev Payer must approve this contract to spend `amount` (+ fee) of payerToken.
    ///      Reverts entirely on any step failure — no partial states.
    /// @param instruction  The payment parameters. payerToken must equal recipientToken.
    /// @return receiptId   Unique identifier for this settled payment.
    function execute(PaymentInstruction calldata instruction)
        external
        returns (bytes32 receiptId);

    /// @notice Preview the payer cost for a same-currency instruction.
    ///         Returns 0 for cross-currency (cost determined off-chain via Circle API).
    /// @return payerAmount Amount in payerToken the payer must supply.
    function quote(PaymentInstruction calldata instruction)
        external
        view
        returns (uint256 payerAmount);

    // ── Admin Functions ────────────────────────────────────────────────────────

    function setDeclarationRegistry(address registry) external;
    function setProtocolFee(uint256 bps) external; // max 30 bps
    function withdrawFees(address token, address to) external;
}
