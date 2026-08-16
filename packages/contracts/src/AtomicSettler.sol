// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPermit2SignatureTransfer} from "./interfaces/IFxEscrow.sol";
import {StableFXAdapter} from "./StableFXAdapter.sol";

/// @title AtomicSettler
/// @notice Settlement engine for Conduit. Two paths:
///
///   1. Same-currency: pull from payer → push to recipient. No API, no FX.
///   2. Cross-currency: submit Permit2 funding for a pre-negotiated Circle
///      StableFX trade. FxEscrow delivers makerToken directly to recipient.
///
/// @dev Full revert on any step failure. No partial states. ReentrancyGuard on all paths.
///
///      Cross-currency prerequisite (enforced by SDK before calling ConduitRouter):
///        - Taker calls USDC.approve(PERMIT2, amount) — once
///        - SDK calls Circle StableFX API → quote → trade → presign
///        - SDK returns permit + witness + signature → passed through ConduitRouter → here
contract AtomicSettler is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    // ── State ─────────────────────────────────────────────────────────────────

    StableFXAdapter public stableFXAdapter;
    mapping(address => bool) public authorizedRouters;

    // ── Events ────────────────────────────────────────────────────────────────

    event DirectSettlement(
        address indexed payer,
        address indexed recipient,
        address token,
        uint256 amount
    );

    event FXSettlementSubmitted(
        address indexed taker,
        address indexed token,
        uint256 takerAmount
    );

    event RouterAuthorized(address indexed router, bool authorized);
    event AdapterUpdated(address indexed adapter);

    // ── Errors ────────────────────────────────────────────────────────────────

    error UnauthorizedRouter(address router);
    error ZeroAmount();
    error ZeroAddress();

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(
        address initialOwner,
        address _stableFXAdapter
    ) Ownable(initialOwner) {
        if (_stableFXAdapter == address(0)) revert ZeroAddress();
        stableFXAdapter = StableFXAdapter(_stableFXAdapter);
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    function setAuthorizedRouter(address router, bool authorized) external onlyOwner {
        authorizedRouters[router] = authorized;
        emit RouterAuthorized(router, authorized);
    }

    function setStableFXAdapter(address adapter) external onlyOwner {
        if (adapter == address(0)) revert ZeroAddress();
        stableFXAdapter = StableFXAdapter(adapter);
        emit AdapterUpdated(adapter);
    }

    // ── Path 1: Same-currency direct settlement ────────────────────────────────

    /// @notice Push pre-received tokens to recipient. USDC→USDC or EURC→EURC.
    ///
    /// @dev The caller (ConduitRouter) must have already pulled `amount` of
    ///      `token` from the payer and transferred them into this contract
    ///      before calling settleDirect. The payer only needs to approve the
    ///      ConduitRouter (single approval for the entire payment).
    ///
    ///      This push model removes the need for the payer to separately approve
    ///      the settler, simplifying the UX to a single ERC-20 approval.
    ///
    /// @param token      ERC-20 token address (USDC or EURC).
    /// @param payer      Original sender — for event emission only.
    /// @param recipient  Address that should receive the tokens.
    /// @param amount     Amount to deliver (already held by this contract).
    function settleDirect(
        address token,
        address payer,
        address recipient,
        uint256 amount
    ) external nonReentrant returns (uint256) {
        if (!authorizedRouters[msg.sender]) revert UnauthorizedRouter(msg.sender);
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();

        // Tokens are already in this contract — push to recipient.
        IERC20(token).safeTransfer(recipient, amount);

        emit DirectSettlement(payer, recipient, token, amount);
        return amount;
    }

    // ── Path 2: Cross-currency via Circle StableFX + Permit2 ──────────────────

    /// @notice Submit Permit2 funding for a Circle StableFX trade.
    /// @dev The SDK has already called the Circle StableFX API off-chain and obtained:
    ///        - permit: token, amount, nonce, deadline (from /quotes response)
    ///        - witness: keccak256(abi.encode(SingleTradeWitness)) (from /presign)
    ///        - witnessTypeString: EIP-712 type string (from /presign)
    ///        - signature: taker's signed funding typed data
    ///      FxEscrow is transferDetails.to — it receives takerToken and delivers makerToken.
    ///      Full revert on failure.
    function settleViaFX(
        IPermit2SignatureTransfer.PermitTransferFrom calldata permit,
        IPermit2SignatureTransfer.SignatureTransferDetails calldata transferDetails,
        address taker,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external nonReentrant {
        if (!authorizedRouters[msg.sender]) revert UnauthorizedRouter(msg.sender);
        if (permit.permitted.amount == 0) revert ZeroAmount();
        if (taker == address(0)) revert ZeroAddress();

        stableFXAdapter.submitFXFunding(
            permit,
            transferDetails,
            taker,
            witness,
            witnessTypeString,
            signature
        );

        emit FXSettlementSubmitted(taker, permit.permitted.token, permit.permitted.amount);
    }
}
