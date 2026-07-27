// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "./MockERC20.sol";

/// @dev Minimal Uniswap V2-compatible router mock for executeWithAmm tests.
///      Fixed exchange rate, no real reserves/slippage math — just enough to
///      exercise ConduitRouter's pull/approve/swap/refund bookkeeping.
contract MockUniswapV2Router {
    uint256 public rateNumerator = 1; // amountIn = amountOut * rateNumerator / rateDenominator
    uint256 public rateDenominator = 1;

    function setRate(uint256 numerator, uint256 denominator) external {
        rateNumerator = numerator;
        rateDenominator = denominator;
    }

    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external returns (uint256[] memory amounts) {
        require(path.length >= 2, "bad path");
        uint256 amountIn = (amountOut * rateNumerator) / rateDenominator;
        require(amountIn <= amountInMax, "excessive input amount");

        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        MockERC20(path[path.length - 1]).mint(to, amountOut);

        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = amountOut;
    }
}
