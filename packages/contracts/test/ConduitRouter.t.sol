// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ConduitRouter} from "../src/ConduitRouter.sol";
import {DeclarationRegistry} from "../src/DeclarationRegistry.sol";
import {AtomicSettler} from "../src/AtomicSettler.sol";
import {StableFXAdapter} from "../src/StableFXAdapter.sol";
import {IConduitRouter} from "../src/interfaces/IConduitRouter.sol";
import {SettlementPreferenceRegistry} from "../src/SettlementPreferenceRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockUniswapV2Router} from "./mocks/MockUniswapV2Router.sol";

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
    StableFXAdapter fxAdapter;
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
        fxAdapter = new StableFXAdapter(OWNER);
        settler   = new AtomicSettler(OWNER, address(fxAdapter));
        router    = new ConduitRouter(OWNER, address(registry), address(settler), address(fxAdapter));

        // Wire authorizations
        fxAdapter.setAuthorizedCaller(address(settler), true);
        settler.setAuthorizedRouter(address(router), true);
        vm.stopPrank();

        // Fund payer
        usdc.mint(PAYER, 1_000 * 1e6); // $1 000 USDC
        eurc.mint(PAYER, 500 * 1e6);   // 500 EURC
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

    // ── executeWithAmm ────────────────────────────────────────────────────────

    function test_executeWithAmm_swapsAndDeliversExactAmount() public {
        MockUniswapV2Router amm = new MockUniswapV2Router();
        amm.setRate(11, 10); // 1.1 usdc per eurc

        uint256 amountOut = 50 * 1e6; // 50 EURC to recipient
        uint256 amountInMax = 60 * 1e6; // slippage cap

        vm.prank(PAYER);
        usdc.approve(address(router), amountInMax);

        address[] memory path = new address[](2);
        path[0] = address(usdc);
        path[1] = address(eurc);

        IConduitRouter.PaymentInstruction memory instruction = IConduitRouter.PaymentInstruction({
            payer: PAYER,
            recipient: RECIPIENT,
            payerToken: address(usdc),
            recipientToken: address(eurc),
            amount: amountOut,
            deadline: block.timestamp + 1 hours,
            declarationId: bytes32(0)
        });

        uint256 payerUsdcBefore = usdc.balanceOf(PAYER);

        vm.prank(PAYER);
        bytes32 receiptId = router.executeWithAmm(instruction, path, amountInMax, address(amm));

        assertNotEq(receiptId, bytes32(0));
        assertEq(eurc.balanceOf(RECIPIENT), amountOut);
        // actualIn = 50 * 1.1 = 55 USDC; payer should be refunded the unused 5 USDC
        uint256 expectedIn = (amountOut * 11) / 10;
        assertEq(payerUsdcBefore - usdc.balanceOf(PAYER), expectedIn);
    }

    function test_executeWithAmm_revertsOnBadPathEnds() public {
        MockUniswapV2Router amm = new MockUniswapV2Router();

        vm.prank(PAYER);
        usdc.approve(address(router), 100 * 1e6);

        address[] memory badPath = new address[](2);
        badPath[0] = address(eurc); // should be payerToken (usdc)
        badPath[1] = address(eurc);

        IConduitRouter.PaymentInstruction memory instruction = IConduitRouter.PaymentInstruction({
            payer: PAYER,
            recipient: RECIPIENT,
            payerToken: address(usdc),
            recipientToken: address(eurc),
            amount: 10 * 1e6,
            deadline: block.timestamp + 1 hours,
            declarationId: bytes32(0)
        });

        vm.expectRevert("path must start at payerToken");
        vm.prank(PAYER);
        router.executeWithAmm(instruction, badPath, 100 * 1e6, address(amm));
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
}
