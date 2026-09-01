// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ConduitRouter} from "../src/ConduitRouter.sol";
import {CurrencyRegistry} from "../src/CurrencyRegistry.sol";
import {DeclarationRegistry} from "../src/DeclarationRegistry.sol";
import {IConduitRouter} from "../src/interfaces/IConduitRouter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// Drives the router with random-ish sequences of execute and withdrawFees.
///
/// A handler rather than letting the fuzzer call the router directly: `execute`
/// requires msg.sender == instruction.payer and a live approval, so unguided
/// calls would revert before touching the accounting the invariant is about.
contract RouterHandler is Test {
    ConduitRouter public router;
    MockERC20 public token;
    address public owner;

    address[3] public payers;

    constructor(ConduitRouter _router, MockERC20 _token, address _owner) {
        router = _router;
        token = _token;
        owner = _owner;
        payers = [makeAddr("p1"), makeAddr("p2"), makeAddr("p3")];
        for (uint256 i = 0; i < payers.length; i++) {
            token.mint(payers[i], 1_000_000 * 1e6);
        }
    }

    function pay(uint256 payerSeed, uint256 amount, uint256 feeSeed) external {
        address payer = payers[payerSeed % payers.length];
        amount = bound(amount, 1, 1_000 * 1e6);

        uint256 bps = feeSeed % (router.MAX_PROTOCOL_FEE_BPS() + 1);
        vm.prank(owner);
        router.setProtocolFee(bps);

        uint256 total = amount + (amount * bps) / 10_000;
        if (token.balanceOf(payer) < total) return;

        vm.prank(payer);
        token.approve(address(router), total);

        vm.prank(payer);
        router.execute(
            IConduitRouter.PaymentInstruction({
                payer: payer,
                recipient: makeAddr("recipient"),
                payerToken: address(token),
                recipientToken: address(token),
                amount: amount,
                deadline: block.timestamp + 1 hours,
                declarationId: bytes32(0)
            })
        );
    }

    function withdraw() external {
        if (router.accumulatedFees(address(token)) == 0) return;
        vm.prank(owner);
        router.withdrawFees(address(token), owner);
    }
}

/// The one property that must hold no matter what order anything happens in:
/// the router can always pay out every fee it has recorded.
///
/// If accumulatedFees ever exceeds the balance, the fee pot is partly other
/// people's money — which is exactly the corruption a fee-on-transfer token
/// would cause, and what Phase A4's registry check exists to prevent.
/// forge-config: default.invariant.runs = 128
/// forge-config: default.invariant.depth = 64
/// forge-config: default.invariant.fail-on-revert = false
contract RouterInvariantTest is Test {
    // fail-on-revert is off because the handler deliberately no-ops rather than
    // reverting on an unfundable sequence; the property below is about the
    // state that results, not about every call succeeding.
    address constant OWNER = address(0x1111);

    ConduitRouter router;
    CurrencyRegistry currencies;
    MockERC20 token;
    RouterHandler handler;

    function setUp() public {
        token = new MockERC20("USD Coin", "USDC", 6);

        vm.startPrank(OWNER);
        DeclarationRegistry declarations = new DeclarationRegistry(OWNER);
        currencies = new CurrencyRegistry(OWNER);
        router = new ConduitRouter(OWNER, address(declarations), address(currencies));
        currencies.registerCurrency("USD", address(token), 6);
        vm.stopPrank();

        handler = new RouterHandler(router, token, OWNER);
        targetContract(address(handler));
    }

    function invariant_feesAreAlwaysCovered() public view {
        assertLe(
            router.accumulatedFees(address(token)),
            token.balanceOf(address(router)),
            "accumulated fees exceed the balance backing them"
        );
    }
}
