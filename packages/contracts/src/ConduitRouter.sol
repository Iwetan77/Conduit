// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IConduitRouter} from "./interfaces/IConduitRouter.sol";
import {CurrencyRegistry} from "./CurrencyRegistry.sol";
import {DeclarationRegistry} from "./DeclarationRegistry.sol";
import {SettlementPreferenceRegistry} from "./SettlementPreferenceRegistry.sol";


/// @title ConduitRouter
/// @notice The single execution surface for all Conduit payments.
///
///         Two settlement paths:
///           - Same-currency (USDC→USDC, EURC→EURC): execute()
///             Payer approves this contract, which pulls and pays out in one call.
///             SDK calls Circle StableFX API off-chain, passes signed Permit2
///             funding data here. FxEscrow settles atomically via Permit2.
///
///         declarationId == bytes32(0) → direct send (no registry lookup)
///         declarationId != bytes32(0) → declaration validated against registry
///
/// @dev All amounts: 6-decimal ERC-20 units. Never 18-decimal native gas values.
///      Protocol params owned by 2-of-3 multisig (Ownable in v1).
/// @dev NON-CUSTODIAL BETWEEN TRANSACTIONS. Every payment pulls from the payer
///      and pays the recipient inside one call; the only balance this contract
///      holds across transactions is `accumulatedFees`, and `withdrawFees`
///      reaches that even while paused.
///
///      That is the reason the guardian pause is not itself a risk. A pause on
///      a custodial contract traps user funds, and handing a hot key the power
///      to do that would be worse than the finding it protects against. Here it
///      stops new payments and strands nothing.
///
///      If a future change makes this contract hold user funds between
///      transactions, that reasoning no longer holds and the pause must be
///      revisited with it.
contract ConduitRouter is IConduitRouter, ReentrancyGuard, Ownable2Step, Pausable {
    using SafeERC20 for IERC20;

    // ── Constants ─────────────────────────────────────────────────────────────

    uint256 public constant MAX_PROTOCOL_FEE_BPS = 30;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    // ── State ─────────────────────────────────────────────────────────────────

    DeclarationRegistry public declarationRegistry;
    SettlementPreferenceRegistry public settlementPreferenceRegistry;

    /// @notice The set of tokens this router will move.
    /// @dev Consulted on every payment. Before this the registry was consulted
    ///      by nothing on-chain, so ANY ERC-20 routed through here — including a
    ///      fee-on-transfer token, which breaks fee accounting outright: the
    ///      router pulls `payerAmount`, receives less than that, then pays out
    ///      the full `instruction.amount` from a pot other payers funded.
    CurrencyRegistry public currencyRegistry;

    /// @notice May call `pause()` and nothing else.
    /// @dev Deliberately asymmetric with `owner`. This is a HOT key, so that a
    ///      response can be fast, and it therefore holds no positive power: it
    ///      cannot unpause, move funds, or change a parameter. Everything it can
    ///      do is a subtraction. Releasing the brake takes the owner's full
    ///      quorum.
    address public guardian;

    uint256 public protocolFeeBps;
    mapping(address => uint256) public accumulatedFees;

    uint256 private _receiptNonce;

    // ── Errors (declared here since IConduitRouter doesn't carry them) ────────

    error PreferenceMismatch(address recipient, address preferenceToken, address instructionToken);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(
        address initialOwner,
        address _declarationRegistry,
        address _currencyRegistry
    ) Ownable(initialOwner) {
        require(_declarationRegistry != address(0), "zero: registry");
        require(_currencyRegistry != address(0), "zero: currency registry");
        declarationRegistry = DeclarationRegistry(_declarationRegistry);
        currencyRegistry = CurrencyRegistry(_currencyRegistry);
    }

    // ── Path 1: Same-currency execute ─────────────────────────────────────────

    /// @inheritdoc IConduitRouter
    /// @dev Use this for USDC→USDC or EURC→EURC payments.
    ///      Payer must approve this contract to spend `amount` (+ fee) of payerToken.
    function execute(PaymentInstruction calldata instruction)
        external
        override
        nonReentrant
        whenNotPaused
        returns (bytes32 receiptId)
    {
        _validateInstruction(instruction);
        // `payer` is a field of a caller-supplied struct, so without this the
        // only thing behind it is the ERC-20 allowance -- and an allowance is a
        // spending limit, not a statement of who may spend it. Anyone could
        // name someone else as payer and send that person's balance wherever
        // they liked.
        //
        require(msg.sender == instruction.payer, "not payer");
        require(
            instruction.payerToken == instruction.recipientToken,
            "this router settles same-currency only"
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

        // Straight to the recipient. This contract already holds the tokens.
        //
        // There used to be a second hop here: push to a separate settler
        // contract, which then pushed to the recipient. It bought nothing. That
        // contract's only guard was an owner-managed router allowlist, and it
        // pushed tokens it "already held" with no verification it had been
        // funded for that call -- so it was a second trust boundary,
        // a second authorization surface an owner could widen, and a second
        // ERC-20 transfer of gas on every single payment.
        //
        // It also corrupted the payer field of every settlement ever recorded.
        // The API matches the transfer that reaches the merchant and reads its
        // sender as the payer; with the settler in the middle, that sender was
        // the settler's own address. One hop makes that reading correct by
        // construction.
        IERC20(instruction.recipientToken).safeTransfer(
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

    // Path 2 was cross-currency via Circle StableFX + Permit2. Removed.
    //
    // It never worked, and it was the single most dangerous function in this
    // repo. Its own doc comment recorded the first half: Circle's presign
    // endpoint issues a Permit2 witness-transfer signed with `spender` = their
    // own relayer, and Permit2 requires msg.sender to equal that spender, so a
    // call arriving through the settler always reverted on signature
    // verification. The working path is Circle's REST fund endpoint and their
    // relayer settling on FxEscrow -- three real Arc transactions, none of them
    // touching this router. packages/api/internal/fx implements it.
    //
    // The second half is why it could not simply be left there. It was
    // `external` with no msg.sender check, and it emitted PaymentSettled
    // populated entirely from the caller's own calldata. Every field
    // _validateInstruction checked against DeclarationRegistry is public
    // on-chain state readable off any victim's declaration, and the money
    // movement was governed by an unrelated permit whose only constraint was
    // that it paid FxEscrow. So anyone could sign a permit for ONE UNIT of any
    // token and emit a settlement event carrying a merchant's declaration id
    // and the full invoice amount. Nothing reverted. The indexer recorded it,
    // the webhook fired, and the merchant's checkout said "payment received".
    // Cost to the attacker: dust plus gas.
    //
    // Nothing replaces it here. Cross-currency does not touch this contract.

    // Path 3 was a cross-currency AMM fallback (executeWithAmm), removed.
    //
    // It could never settle: Arc has no USDC/EURC pool, so the swap it depended
    // on had no liquidity to execute against. Cross-currency goes through Circle
    // StableFX. Nothing in this repo called it, while it stayed deployed and
    // publicly callable, taking an unvalidated router address and approving that
    // address over tokens this contract holds -- including accumulated fees.

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
        require(registry != address(0), "zero: registry");
        declarationRegistry = DeclarationRegistry(registry);
        emit DeclarationRegistrySet(registry);
    }


    function setCurrencyRegistry(address registry) external onlyOwner {
        require(registry != address(0), "zero: currency registry");
        currencyRegistry = CurrencyRegistry(registry);
        emit CurrencyRegistrySet(registry);
    }

    /// @notice Name the address that may pause payments.
    /// @dev Owner-only, and setting it to zero is allowed: revoking a
    ///      compromised guardian must not require having a replacement ready.
    function setGuardian(address newGuardian) external onlyOwner {
        guardian = newGuardian;
        emit GuardianSet(newGuardian);
    }

    /// @notice Stop `execute`. Callable by the guardian or the owner.
    function pause() external {
        require(msg.sender == guardian || msg.sender == owner(), "not guardian");
        _pause();
        emit PausedBy(msg.sender);
    }

    /// @notice Resume `execute`. OWNER ONLY — the guardian cannot undo its own
    ///         brake, which is what makes handing that key out survivable.
    function unpause() external onlyOwner {
        _unpause();
        emit UnpausedBy(msg.sender);
    }

    function setSettlementPreferenceRegistry(address registry) external onlyOwner {
        require(registry != address(0), "zero: preference registry");
        settlementPreferenceRegistry = SettlementPreferenceRegistry(registry);
        emit SettlementPreferenceRegistrySet(registry);
    }

    /// @dev Emits ProtocolFeeSet. A fee change moves what every payer is
    ///      charged, and it was previously the one admin action that left no
    ///      trace an indexer could follow.
    function setProtocolFee(uint256 bps) external override onlyOwner {
        require(bps <= MAX_PROTOCOL_FEE_BPS, "fee too high");
        protocolFeeBps = bps;
        emit ProtocolFeeSet(bps);
    }

    /// @dev `to` is checked because safeTransfer to address(0) succeeds for
    ///      most ERC-20s -- it is an ordinary balance update, not a revert --
    ///      so a mistyped recipient burns the accumulated fees irreversibly
    ///      after the balance has already been zeroed.
    /// @dev Reachable WHILE PAUSED, deliberately. The pause stops payments; it
    ///      is not a freeze on money already owed. See the contract header.
    function withdrawFees(address token, address to) external override onlyOwner {
        require(to != address(0), "zero: to");
        uint256 amount = accumulatedFees[token];
        // A zero withdrawal emits an event saying fees were withdrawn and moves
        // nothing, which is a lie in the log an indexer will faithfully record.
        require(amount > 0, "no fees");
        accumulatedFees[token] = 0;
        IERC20(token).safeTransfer(to, amount);
        emit FeesWithdrawn(token, to, amount);
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _validateInstruction(PaymentInstruction calldata instruction) internal view {
        // The registry is now load-bearing rather than decorative. An
        // unregistered or disabled token cannot be routed at all, which is what
        // keeps a fee-on-transfer or rebasing token out of the fee accounting
        // it would otherwise corrupt.
        require(
            currencyRegistry.isEnabledToken(instruction.payerToken),
            "token not enabled"
        );
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
