// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IConduitRouter} from "./interfaces/IConduitRouter.sol";
import {IPermit2SignatureTransfer} from "./interfaces/IFxEscrow.sol";
import {DeclarationRegistry} from "./DeclarationRegistry.sol";
import {AtomicSettler} from "./AtomicSettler.sol";
import {StableFXAdapter} from "./StableFXAdapter.sol";

/// @title ConduitRouter
/// @notice The single execution surface for all Conduit payments.
///
///         Two settlement paths:
///           - Same-currency (USDC→USDC, EURC→EURC): execute()
///             Payer approves this contract. AtomicSettler pulls + pushes.
///           - Cross-currency (USDC↔EURC): executeWithFX()
///             SDK calls Circle StableFX API off-chain, passes signed Permit2
///             funding data here. FxEscrow settles atomically via Permit2.
///
///         declarationId == bytes32(0) → direct send (no registry lookup)
///         declarationId != bytes32(0) → declaration validated against registry
///
/// @dev All amounts: 6-decimal ERC-20 units. Never 18-decimal native gas values.
///      Protocol params owned by 2-of-3 multisig (Ownable in v1).
contract ConduitRouter is IConduitRouter, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    // ── Constants ─────────────────────────────────────────────────────────────

    uint256 public constant MAX_PROTOCOL_FEE_BPS = 30;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    // ── State ─────────────────────────────────────────────────────────────────

    DeclarationRegistry public declarationRegistry;
    AtomicSettler public atomicSettler;
    StableFXAdapter public stableFXAdapter;

    uint256 public protocolFeeBps;
    mapping(address => uint256) public accumulatedFees;

    uint256 private _receiptNonce;

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(
        address initialOwner,
        address _declarationRegistry,
        address _atomicSettler,
        address _stableFXAdapter
    ) Ownable(initialOwner) {
        require(_declarationRegistry != address(0), "zero: registry");
        require(_atomicSettler != address(0), "zero: settler");
        require(_stableFXAdapter != address(0), "zero: adapter");

        declarationRegistry = DeclarationRegistry(_declarationRegistry);
        atomicSettler = AtomicSettler(_atomicSettler);
        stableFXAdapter = StableFXAdapter(_stableFXAdapter);
    }

    // ── Path 1: Same-currency execute ─────────────────────────────────────────

    /// @inheritdoc IConduitRouter
    /// @dev Use this for USDC→USDC or EURC→EURC payments.
    ///      Payer must approve this contract to spend `amount` (+ fee) of payerToken.
    function execute(PaymentInstruction calldata instruction)
        external
        override
        nonReentrant
        returns (bytes32 receiptId)
    {
        _validateInstruction(instruction);
        require(
            instruction.payerToken == instruction.recipientToken,
            "use executeWithFX for cross-currency"
        );

        uint256 feeAmount  = (instruction.amount * protocolFeeBps) / BPS_DENOMINATOR;
        uint256 payerAmount = instruction.amount + feeAmount;

        // Single pull from payer: full amount (payment + fee).
        // Payer only needs to approve THIS contract — not the settler.
        IERC20(instruction.payerToken).safeTransferFrom(
            instruction.payer,
            address(this),
            payerAmount
        );

        if (feeAmount > 0) {
            accumulatedFees[instruction.payerToken] += feeAmount;
        }

        // Push payment portion to settler, settler delivers to recipient.
        IERC20(instruction.recipientToken).safeTransfer(
            address(atomicSettler),
            instruction.amount
        );

        atomicSettler.settleDirect(
            instruction.recipientToken,
            instruction.payer,
            instruction.recipient,
            instruction.amount
        );

        receiptId = _mintReceipt(instruction);

        emit PaymentSettled(
            receiptId,
            instruction.payer,
            instruction.recipient,
            instruction.payerToken,
            instruction.recipientToken,
            payerAmount,
            instruction.amount,
            instruction.declarationId,
            block.timestamp
        );
    }

    // ── Path 2: Cross-currency execute via Circle StableFX + Permit2 ──────────

    /// @notice Execute a cross-currency payment.
    /// @dev The SDK calls the Circle StableFX API off-chain before invoking this:
    ///        POST /v1/exchange/stablefx/quotes      → quote + EIP-712 typedData
    ///        POST /v1/exchange/stablefx/trades       → contractTradeId
    ///        POST /v1/exchange/stablefx/signatures/funding/presign → funding typedData
    ///      The taker signs the funding typed data, SDK passes it here.
    ///      Permit2 transfers takerToken → FxEscrow, FxEscrow delivers makerToken → recipient.
    ///
    /// @param instruction       Payment parameters (payerToken != recipientToken).
    /// @param permit            Permit2 transfer authorization (takerToken, amount, nonce, deadline).
    /// @param transferDetails   to = FxEscrow address, requestedAmount = takerAmount.
    /// @param witness           keccak256(abi.encode(SingleTradeWitness { id: contractTradeId })).
    /// @param witnessTypeString EIP-712 type string from Circle presign response.
    /// @param fundingSignature  Taker's EIP-712 signature over funding typed data.
    function executeWithFX(
        PaymentInstruction calldata instruction,
        IPermit2SignatureTransfer.PermitTransferFrom calldata permit,
        IPermit2SignatureTransfer.SignatureTransferDetails calldata transferDetails,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata fundingSignature
    ) external nonReentrant returns (bytes32 receiptId) {
        _validateInstruction(instruction);
        require(
            instruction.payerToken != instruction.recipientToken,
            "use execute() for same-currency"
        );
        require(
            instruction.payer == msg.sender || instruction.payer == tx.origin,
            "payer mismatch"
        );
        require(
            permit.deadline >= block.timestamp,
            "permit expired"
        );
        // transferDetails.to must be FxEscrow — the SDK enforces this
        require(
            transferDetails.to == stableFXAdapter.FX_ESCROW(),
            "transferDetails.to must be FxEscrow"
        );

        // Submit Permit2 funding → FxEscrow settles atomically
        // After this call, recipient has received makerToken directly from FxEscrow
        atomicSettler.settleViaFX(
            permit,
            transferDetails,
            instruction.payer,
            witness,
            witnessTypeString,
            fundingSignature
        );

        receiptId = _mintReceipt(instruction);

        emit PaymentSettled(
            receiptId,
            instruction.payer,
            instruction.recipient,
            instruction.payerToken,
            instruction.recipientToken,
            permit.permitted.amount, // payerAmount (takerAmount)
            instruction.amount,       // recipientAmount (makerAmount)
            instruction.declarationId,
            block.timestamp
        );
    }

    // ── Quote (view) ──────────────────────────────────────────────────────────

    /// @inheritdoc IConduitRouter
    function quote(PaymentInstruction calldata instruction)
        external
        view
        override
        returns (uint256 payerAmount)
    {
        if (instruction.payerToken == instruction.recipientToken) {
            uint256 fee = (instruction.amount * protocolFeeBps) / BPS_DENOMINATOR;
            return instruction.amount + fee;
        }
        // Cross-currency: payerAmount comes from Circle StableFX API off-chain.
        return 0;
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    function setDeclarationRegistry(address registry) external override onlyOwner {
        declarationRegistry = DeclarationRegistry(registry);
        emit DeclarationRegistrySet(registry);
    }

    function setStableFXAdapter(address adapter) external override onlyOwner {
        stableFXAdapter = StableFXAdapter(adapter);
        emit StableFXAdapterSet(adapter);
    }

    function setAtomicSettler(address settler) external override onlyOwner {
        atomicSettler = AtomicSettler(settler);
        emit AtomicSettlerSet(settler);
    }

    function setProtocolFee(uint256 bps) external override onlyOwner {
        require(bps <= MAX_PROTOCOL_FEE_BPS, "fee too high");
        protocolFeeBps = bps;
    }

    function withdrawFees(address token, address to) external override onlyOwner {
        uint256 amount = accumulatedFees[token];
        accumulatedFees[token] = 0;
        IERC20(token).safeTransfer(to, amount);
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _validateInstruction(PaymentInstruction calldata instruction) internal view {
        require(instruction.recipient != address(0), "zero recipient");
        require(instruction.payer != address(0), "zero payer");
        require(instruction.amount > 0, "zero amount");
        require(block.timestamp <= instruction.deadline, "instruction expired");

        if (instruction.declarationId != bytes32(0)) {
            DeclarationRegistry.PaymentDeclaration memory decl =
                declarationRegistry.resolve(instruction.declarationId);

            require(decl.active, "declaration inactive");
            require(decl.recipient == instruction.recipient, "recipient mismatch");
            require(decl.recipientToken == instruction.recipientToken, "token mismatch");

            if (decl.amount > 0) {
                require(instruction.amount == decl.amount, "amount mismatch");
            }
        }
    }

    function _mintReceipt(PaymentInstruction calldata instruction)
        internal
        returns (bytes32)
    {
        _receiptNonce++;
        return keccak256(
            abi.encodePacked(
                instruction.payer,
                instruction.recipient,
                instruction.amount,
                block.timestamp,
                _receiptNonce
            )
        );
    }
}
