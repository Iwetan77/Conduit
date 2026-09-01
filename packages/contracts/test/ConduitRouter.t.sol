// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ConduitRouter} from "../src/ConduitRouter.sol";
import {DeclarationRegistry} from "../src/DeclarationRegistry.sol";
import {AtomicSettler} from "../src/AtomicSettler.sol";
import {IConduitRouter} from "../src/interfaces/IConduitRouter.sol";
import {SettlementPreferenceRegistry} from "../src/SettlementPreferenceRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @dev Integration tests for ConduitRouter — uses MockERC20 because Arc
///      Testnet's USDC uses native precompiles (0x1800...) that Foundry cannot
///      simulate in fork mode. End-to-end live testing happens via Deploy.s.sol.
///
///      Run: forge test --match-contract ConduitRouter -vvv
contract ConduitRouterTest is Test {
    address constant OWNER = address(0x1111);

    address PAYER;
    address RECIPIENT;
    uint256 payerKey;

    MockERC20 usdc;
    MockERC20 eurc;

    DeclarationRegistry registry;
    AtomicSettler settler;
    ConduitRouter router;

    function setUp() public {
        (PAYER, payerKey) = makeAddrAndKey("payer");
        (RECIPIENT,)      = makeAddrAndKey("recipient");

        // Mock tokens (6 decimals, same as real USDC / EURC)
        usdc = new MockERC20("USD Coin",  "USDC", 6);
        eurc = new MockERC20("Euro Coin", "EURC", 6);

        // Deploy protocol
        vm.startPrank(OWNER);
        registry  = new DeclarationRegistry(OWNER);
        settler   = new AtomicSettler(OWNER);
        router    = new ConduitRouter(OWNER, address(registry), address(settler));

        // Wire authorizations
        settler.setAuthorizedRouter(address(router), true);
        vm.stopPrank();

        // Fund payer
        usdc.mint(PAYER, 1_000 * 1e6); // $1 000 USDC
        eurc.mint(PAYER, 500 * 1e6);   // 500 EURC
    }

    // ── Admin guards (SolidityScan: missing zero-address validation, events) ──

    /// The constructor rejected zero for these three, but the setters that
    /// REPLACE them did not — so the guard held at deploy time and then went
    /// away for the rest of the contract's life. Setting any to address(0)
    /// points the router at an address with no code.
    function test_setters_rejectZeroAddress() public {
        vm.startPrank(OWNER);
        vm.expectRevert(bytes("zero: registry"));
        router.setDeclarationRegistry(address(0));

        // setStableFXAdapter's case was here. The setter went with
        // executeWithFX in Phase A1.
        vm.expectRevert(bytes("zero: settler"));
        router.setAtomicSettler(address(0));

        vm.expectRevert(bytes("zero: preference registry"));
        router.setSettlementPreferenceRegistry(address(0));
        vm.stopPrank();
    }

    /// safeTransfer to address(0) is an ordinary balance update for most
    /// ERC-20s, not a revert — so without this guard a mistyped recipient
    /// burns the fees, and does it AFTER the balance has been zeroed.
    function test_withdrawFees_rejectsZeroRecipient() public {
        vm.prank(OWNER);
        vm.expectRevert(bytes("zero: to"));
        router.withdrawFees(address(usdc), address(0));
    }

    /// A fee change alters what every payer is charged and was the one admin
    /// action leaving no trace an indexer could follow.
    function test_setProtocolFee_emitsEvent() public {
        vm.prank(OWNER);
        vm.expectEmit(false, false, false, true);
        emit IConduitRouter.ProtocolFeeSet(25);
        router.setProtocolFee(25);
    }

    // ── Direct Send — Same Currency ───────────────────────────────────────────

    function test_directSend_sameToken() public {
        uint256 sendAmount = 10 * 1e6;
        uint256 deadline   = block.timestamp + 1 hours;

        vm.prank(PAYER);
        usdc.approve(address(router), sendAmount);

        IConduitRouter.PaymentInstruction memory instruction = IConduitRouter.PaymentInstruction({
            payer:         PAYER,
            recipient:     RECIPIENT,
            payerToken:    address(usdc),
            recipientToken: address(usdc),
            amount:        sendAmount,
            deadline:      deadline,
            declarationId: bytes32(0)
        });

        uint256 recipientBefore = usdc.balanceOf(RECIPIENT);

        vm.prank(PAYER);
        bytes32 receiptId = router.execute(instruction);

        assertNotEq(receiptId, bytes32(0));
        assertEq(usdc.balanceOf(RECIPIENT) - recipientBefore, sendAmount);
        console2.log("ReceiptId:", vm.toString(receiptId));
    }

    // ── Declaration Flow ──────────────────────────────────────────────────────

    function test_declarationFlow_register_and_fulfill() public {
        uint256 requestAmount = 50 * 1e6;

        vm.prank(RECIPIENT);
        bytes32 declarationId = registry.register(address(usdc), requestAmount);

        DeclarationRegistry.PaymentDeclaration memory decl = registry.resolve(declarationId);
        assertEq(decl.recipient, RECIPIENT);
        assertEq(decl.amount, requestAmount);
        assertTrue(decl.active);

        vm.prank(PAYER);
        usdc.approve(address(router), requestAmount);

        IConduitRouter.PaymentInstruction memory instruction = IConduitRouter.PaymentInstruction({
            payer:         PAYER,
            recipient:     RECIPIENT,
            payerToken:    address(usdc),
            recipientToken: address(usdc),
            amount:        requestAmount,
            deadline:      block.timestamp + 1 hours,
            declarationId: declarationId
        });

        uint256 recipientBefore = usdc.balanceOf(RECIPIENT);

        vm.prank(PAYER);
        bytes32 receiptId = router.execute(instruction);

        assertNotEq(receiptId, bytes32(0));
        assertEq(usdc.balanceOf(RECIPIENT) - recipientBefore, requestAmount);
    }

    function test_execute_revertsIfDeclarationInactive() public {
        vm.prank(RECIPIENT);
        bytes32 declarationId = registry.register(address(usdc), 10 * 1e6);

        vm.prank(RECIPIENT);
        registry.deactivate(declarationId);

        vm.prank(PAYER);
        usdc.approve(address(router), 10 * 1e6);

        IConduitRouter.PaymentInstruction memory instruction = IConduitRouter.PaymentInstruction({
            payer:         PAYER,
            recipient:     RECIPIENT,
            payerToken:    address(usdc),
            recipientToken: address(usdc),
            amount:        10 * 1e6,
            deadline:      block.timestamp + 1 hours,
            declarationId: declarationId
        });

        vm.expectRevert("declaration inactive");
        vm.prank(PAYER);
        router.execute(instruction);
    }

    function test_execute_revertsIfDeadlinePassed() public {
        IConduitRouter.PaymentInstruction memory instruction = IConduitRouter.PaymentInstruction({
            payer:         PAYER,
            recipient:     RECIPIENT,
            payerToken:    address(usdc),
            recipientToken: address(usdc),
            amount:        10 * 1e6,
            deadline:      block.timestamp - 1,
            declarationId: bytes32(0)
        });

        vm.expectRevert("instruction expired");
        vm.prank(PAYER);
        router.execute(instruction);
    }

    // ── Protocol Fee ──────────────────────────────────────────────────────────

    function test_protocolFee_collected() public {
        vm.prank(OWNER);
        router.setProtocolFee(10); // 0.10%

        uint256 sendAmount = 100 * 1e6;
        uint256 fee        = (sendAmount * 10) / 10_000;
        uint256 totalCost  = sendAmount + fee;

        vm.prank(PAYER);
        usdc.approve(address(router), totalCost);

        IConduitRouter.PaymentInstruction memory instruction = IConduitRouter.PaymentInstruction({
            payer:         PAYER,
            recipient:     RECIPIENT,
            payerToken:    address(usdc),
            recipientToken: address(usdc),
            amount:        sendAmount,
            deadline:      block.timestamp + 1 hours,
            declarationId: bytes32(0)
        });

        vm.prank(PAYER);
        router.execute(instruction);

        assertEq(router.accumulatedFees(address(usdc)), fee);

        vm.prank(OWNER);
        router.withdrawFees(address(usdc), OWNER);
        assertEq(router.accumulatedFees(address(usdc)), 0);
        assertEq(usdc.balanceOf(OWNER), fee);
    }

    // ── Quote ─────────────────────────────────────────────────────────────────

    function test_quote_sameToken_noFee() public view {
        IConduitRouter.PaymentInstruction memory instruction = IConduitRouter.PaymentInstruction({
            payer:         PAYER,
            recipient:     RECIPIENT,
            payerToken:    address(usdc),
            recipientToken: address(usdc),
            amount:        50 * 1e6,
            deadline:      block.timestamp + 1 hours,
            declarationId: bytes32(0)
        });

        uint256 q = router.quote(instruction);
        assertEq(q, 50 * 1e6);
    }

    // ── Settlement preference override ──────────────────────────────────────

    function test_directSend_recipientPreferenceOverride_matchingTokenSucceeds() public {
        SettlementPreferenceRegistry prefRegistry = new SettlementPreferenceRegistry();
        vm.prank(OWNER);
        router.setSettlementPreferenceRegistry(address(prefRegistry));

        vm.prank(RECIPIENT);
        prefRegistry.setPreference(address(usdc));

        uint256 sendAmount = 10 * 1e6;
        vm.prank(PAYER);
        usdc.approve(address(router), sendAmount);

        IConduitRouter.PaymentInstruction memory instruction = IConduitRouter.PaymentInstruction({
            payer: PAYER,
            recipient: RECIPIENT,
            payerToken: address(usdc),
            recipientToken: address(usdc), // matches preference
            amount: sendAmount,
            deadline: block.timestamp + 1 hours,
            declarationId: bytes32(0)
        });

        vm.prank(PAYER);
        bytes32 receiptId = router.execute(instruction);
        assertNotEq(receiptId, bytes32(0));
    }

    function test_directSend_recipientPreferenceOverride_mismatchReverts() public {
        SettlementPreferenceRegistry prefRegistry = new SettlementPreferenceRegistry();
        vm.prank(OWNER);
        router.setSettlementPreferenceRegistry(address(prefRegistry));

        // Recipient's standing preference is EURC...
        vm.prank(RECIPIENT);
        prefRegistry.setPreference(address(eurc));

        uint256 sendAmount = 10 * 1e6;
        vm.prank(PAYER);
        usdc.approve(address(router), sendAmount);

        // ...but this instruction (no declaration) targets USDC — must be rejected,
        // not silently honoured.
        IConduitRouter.PaymentInstruction memory instruction = IConduitRouter.PaymentInstruction({
            payer: PAYER,
            recipient: RECIPIENT,
            payerToken: address(usdc),
            recipientToken: address(usdc),
            amount: sendAmount,
            deadline: block.timestamp + 1 hours,
            declarationId: bytes32(0)
        });

        vm.expectRevert(
            abi.encodeWithSelector(
                ConduitRouter.PreferenceMismatch.selector, RECIPIENT, address(eurc), address(usdc)
            )
        );
        vm.prank(PAYER);
        router.execute(instruction);
    }

    function test_directSend_noPreferenceSet_anyTokenAllowed() public {
        SettlementPreferenceRegistry prefRegistry = new SettlementPreferenceRegistry();
        vm.prank(OWNER);
        router.setSettlementPreferenceRegistry(address(prefRegistry));
        // RECIPIENT never calls setPreference — behaviour must be unchanged from before.

        uint256 sendAmount = 10 * 1e6;
        vm.prank(PAYER);
        usdc.approve(address(router), sendAmount);

        IConduitRouter.PaymentInstruction memory instruction = IConduitRouter.PaymentInstruction({
            payer: PAYER,
            recipient: RECIPIENT,
            payerToken: address(usdc),
            recipientToken: address(usdc),
            amount: sendAmount,
            deadline: block.timestamp + 1 hours,
            declarationId: bytes32(0)
        });

        vm.prank(PAYER);
        bytes32 receiptId = router.execute(instruction);
        assertNotEq(receiptId, bytes32(0));
    }

    function test_declarationFlow_ignoresRecipientPreference() public {
        // Declarations are their own authority — the preference override only
        // applies to declarationId == 0 (direct sends).
        SettlementPreferenceRegistry prefRegistry = new SettlementPreferenceRegistry();
        vm.prank(OWNER);
        router.setSettlementPreferenceRegistry(address(prefRegistry));

        vm.prank(RECIPIENT);
        prefRegistry.setPreference(address(eurc)); // prefers EURC

        vm.prank(RECIPIENT);
        bytes32 declarationId = registry.register(address(usdc), 10 * 1e6); // declares USDC

        vm.prank(PAYER);
        usdc.approve(address(router), 10 * 1e6);

        IConduitRouter.PaymentInstruction memory instruction = IConduitRouter.PaymentInstruction({
            payer: PAYER,
            recipient: RECIPIENT,
            payerToken: address(usdc),
            recipientToken: address(usdc),
            amount: 10 * 1e6,
            deadline: block.timestamp + 1 hours,
            declarationId: declarationId
        });

        vm.prank(PAYER);
        bytes32 receiptId = router.execute(instruction);
        assertNotEq(receiptId, bytes32(0));
    }

    // ── Payer authorization ───────────────────────────────────────────────────
    //
    // `payer` is a field of a caller-supplied struct. The only thing that ever
    // stood behind it was the ERC-20 allowance, and the SDK made that
    // unlimited and permanent on first use, so every wallet that had paid once
    // was reachable by anyone who read an Approval event off the chain.
    //
    // Every pre-existing test here pranks as PAYER before calling, so the
    // question these ask -- what happens when someone else calls -- had never
    // been put to the contract.
    //
    // executeWithFX no longer exists. Phase A1 deleted it: it could never
    // settle a real StableFX signature (Permit2 requires msg.sender to equal
    // the spender Circle signed, which is their relayer), and being external
    // with no sender check it let anyone emit PaymentSettled for a merchant's
    // full invoice while moving one unit of any token.

    function test_execute_revertsWhenCallerIsNotPayer() public {
        address attacker = makeAddr("attacker");
        uint256 victimBalance = usdc.balanceOf(PAYER);

        // The state the SDK actually left every payer in: unlimited, permanent.
        vm.prank(PAYER);
        usdc.approve(address(router), type(uint256).max);

        IConduitRouter.PaymentInstruction memory instruction = IConduitRouter.PaymentInstruction({
            payer:         PAYER,
            recipient:     attacker,
            payerToken:    address(usdc),
            recipientToken: address(usdc),
            amount:        victimBalance,
            deadline:      block.timestamp + 1 hours,
            declarationId: bytes32(0)
        });

        vm.prank(attacker);
        vm.expectRevert(bytes("not payer"));
        router.execute(instruction);

        assertEq(usdc.balanceOf(PAYER), victimBalance, "payer balance must be untouched");
        assertEq(usdc.balanceOf(attacker), 0, "attacker must receive nothing");
    }

    /// The guard must not cost the payer their own payment.
    function test_execute_stillWorksForPayer() public {
        uint256 sendAmount = 10 * 1e6;

        vm.prank(PAYER);
        usdc.approve(address(router), sendAmount);

        IConduitRouter.PaymentInstruction memory instruction = IConduitRouter.PaymentInstruction({
            payer:         PAYER,
            recipient:     RECIPIENT,
            payerToken:    address(usdc),
            recipientToken: address(usdc),
            amount:        sendAmount,
            deadline:      block.timestamp + 1 hours,
            declarationId: bytes32(0)
        });

        uint256 recipientBefore = usdc.balanceOf(RECIPIENT);

        vm.prank(PAYER);
        bytes32 receiptId = router.execute(instruction);

        assertNotEq(receiptId, bytes32(0));
        assertEq(usdc.balanceOf(RECIPIENT) - recipientBefore, sendAmount);
    }
}
