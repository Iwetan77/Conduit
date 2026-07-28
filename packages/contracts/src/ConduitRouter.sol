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
import {SettlementPreferenceRegistry} from "./SettlementPreferenceRegistry.sol";

/// @dev Minimal Uniswap V2-compatible router interface for the AMM fallback path.
///      Same interface StableFXAdapter uses internally — declared again here so
///      ConduitRouter.executeWithAmm doesn't depend on StableFXAdapter internals.
interface IUniswapV2RouterMinimal {
    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

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
    SettlementPreferenceRegistry public settlementPreferenceRegistry;

    uint256 public protocolFeeBps;
    mapping(address => uint256) public accumulatedFees;

    uint256 private _receiptNonce;

    // ── Errors (declared here since IConduitRouter doesn't carry them) ────────

    error PreferenceMismatch(address recipient, address preferenceToken, address instructionToken);

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
    /// @dev NON-FUNCTIONAL AGAINST REAL STABLEFX SIGNATURES — kept for reference,
    ///      do not wire the API layer to call this for StableFX-routed payments.
    ///      Verified empirically (real signature, real Arc testnet call): the
    ///      funding permit StableFX's presign endpoint returns is an EIP-712
    ///      Permit2 witness-transfer signed with `spender` = Circle's own relayer
    ///      contract (observed: 0xd68256f4d69c6bbecb873d8588ae0dc6b8e22e10 on Arc
    ///      testnet), not this router or AtomicSettler. Permit2.permitWitnessTransferFrom
    ///      authenticates the caller as `msg.sender` and requires it to equal the
    ///      signed `spender` — so a call originating from AtomicSettler (as this
    ///      function is wired to do, via settleViaFX) always reverts on signature
    ///      verification. There is no way to make OUR contract the valid caller
    ///      for a signature Circle's presign endpoint issued; only Circle's own
    ///      relayer can redeem it. Confirmed the actual working flow instead:
    ///      submit the funding signature to Circle's own
    ///      `POST /v1/exchange/stablefx/fund` REST endpoint; their relayer settles
    ///      on FxEscrow directly (recordTrade → takerDeliver → makerDeliver, all
    ///      real on-chain txs, none of them calling this router). The Go API
    ///      layer (packages/api/internal/fx) implements this correct path — see
    ///      its package doc comment. This function and the on-chain
    ///      AtomicSettler.settleViaFX / StableFXAdapter.submitFXFunding path it
    ///      depends on are consequently dead code for the StableFX rail; left in
    ///      place rather than deleted since removing them is a larger, separate
    ///      change (would also touch AtomicSettler/StableFXAdapter/tests) and
    ///      this is a documentation-first flag, not a rewrite, given how late in
    ///      the build this was discovered. Flagged in STATUS.md.
    ///
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
        // No msg.sender/tx.origin check on the payer here — deliberately.
        // Permit2.permitWitnessTransferFrom (called inside atomicSettler.settleViaFX)
        // verifies `fundingSignature` against `instruction.payer` as the signing
        // owner; that signature IS the payer's authorization, independent of who
        // submits this transaction. A msg.sender/tx.origin check would just be a
        // weaker, spoofable proxy for something Permit2 already checks
        // cryptographically — and it would block third-party/relayer submission,
        // which is exactly what Phase 5 (gas-sponsored settlement, so the payer
        // never needs a gas token) requires. Submission is intentionally open;
        // fund authorization is Permit2's signature check, not msg.sender.
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

    // ── Path 3: Cross-currency execute via AMM fallback ───────────────────────

    /// @notice Execute a cross-currency payment by routing through a Uniswap
    ///         V2-compatible AMM. Fallback only — used for pairs StableFX
    ///         refuses to quote (see docs/fx-capability.md for which pairs that
    ///         is today). Provider selection happens off-chain in the Go API;
    ///         this entry point just executes whichever route it picked.
    /// @param path        [payerToken, ..., recipientToken] — validated at the ends only.
    /// @param amountInMax Maximum payerToken the payer will spend (slippage cap,
    ///                    computed off-chain via the router's getAmountsIn).
    /// @param ammRouter   Uniswap V2-compatible router address (ArcSwap or UnitFlow).
    function executeWithAmm(
        PaymentInstruction calldata instruction,
        address[] calldata path,
        uint256 amountInMax,
        address ammRouter
    ) external nonReentrant returns (bytes32 receiptId) {
        _validateInstruction(instruction);
        require(
            instruction.payerToken != instruction.recipientToken,
            "use execute() for same-currency"
        );
        require(path.length >= 2, "invalid path");
        require(path[0] == instruction.payerToken, "path must start at payerToken");
        require(path[path.length - 1] == instruction.recipientToken, "path must end at recipientToken");

        IERC20(instruction.payerToken).safeTransferFrom(instruction.payer, address(this), amountInMax);
        IERC20(instruction.payerToken).approve(ammRouter, amountInMax);

        uint256[] memory amounts = IUniswapV2RouterMinimal(ammRouter).swapTokensForExactTokens(
            instruction.amount,
            amountInMax,
            path,
            instruction.recipient,
            instruction.deadline
        );
        uint256 actualIn = amounts[0];

        uint256 leftover = amountInMax - actualIn;
        if (leftover > 0) {
            IERC20(instruction.payerToken).safeTransfer(instruction.payer, leftover);
        }
        IERC20(instruction.payerToken).approve(ammRouter, 0);

        receiptId = _mintReceipt(instruction);

        emit PaymentSettled(
            receiptId,
            instruction.payer,
            instruction.recipient,
            instruction.payerToken,
            instruction.recipientToken,
            actualIn,
            instruction.amount,
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

    function setSettlementPreferenceRegistry(address registry) external onlyOwner {
        settlementPreferenceRegistry = SettlementPreferenceRegistry(registry);
        emit SettlementPreferenceRegistrySet(registry);
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
        } else if (address(settlementPreferenceRegistry) != address(0)) {
            // Direct send (no declaration): the recipient's standing settlement
            // preference, if any, is authoritative. A caller-built instruction
            // that targets a different token than the recipient's preference is
            // rejected outright rather than silently honoured — the recipient's
            // choice of what they hold wins, or the payment fails loudly.
            (address prefToken, bool prefActive) =
                settlementPreferenceRegistry.preferenceOf(instruction.recipient);
            if (prefActive && prefToken != instruction.recipientToken) {
                revert PreferenceMismatch(instruction.recipient, prefToken, instruction.recipientToken);
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
