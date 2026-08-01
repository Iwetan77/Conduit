// Cross-currency swap via Arc testnet AMMs.
//
// Routers queried (best price wins):
//   1. ArcSwap  — Uniswap V2 by Arc Foundation
//                 Router:  0x48a9bd1644ac67fbef4183261c466bea3eb333fc
//   2. UnitFlow — V2.5 AMM (Uniswap V2-compatible)
//                 Router:  0x4AA8c7Ac458479d9A4FA5c1481e03061ac76824A
//
// Uses swapTokensForExactTokens — recipient always receives the exact declared
// amount. Payer's max input = getAmountsIn(amountOut) * 1.01 (1% slippage cap).
// AMM router approval is MaxUint256 so it only happens on first-ever use.

import { ethers } from "ethers";
import type { Currency } from "./types.js";
import { currencyToAddress, currencyDecimals } from "./currency.js";
import { toHumanAmount as toHumanAmountGeneric, fromHumanAmount as fromHumanAmountGeneric } from "./amount.js";

const ARC_RPC = "https://rpc.testnet.arc.network";
const ARC_CHAIN_ID = 5042002;
const ARC_EXPLORER = "https://testnet.arcscan.app";

interface RouterConfig { name: string; address: string }

const ROUTERS: RouterConfig[] = [
  { name: "ArcSwap",  address: "0x48a9bd1644ac67fbef4183261c466bea3eb333fc" },
  { name: "UnitFlow", address: "0x4AA8c7Ac458479d9A4FA5c1481e03061ac76824A" },
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const V2_ROUTER_ABI = [
  "function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
  "function getAmountsIn(uint amountOut, address[] calldata path) external view returns (uint[] memory amounts)",
];

// ── Public types ──────────────────────────────────────────────────────────────

export interface SwapResult {
  tokenIn: Currency;
  tokenOut: Currency;
  amountIn: string;
  amountOutRaw?: string;
  txHash: string;
  explorerUrl: string;
}

// ── Best-price router selection ───────────────────────────────────────────────

interface RouterQuote { router: RouterConfig; requiredIn: bigint }

async function getBestRouter(
  provider: ethers.Provider,
  amountOut: bigint,
  path: string[]
): Promise<RouterQuote> {
  const quotes = await Promise.allSettled(
    ROUTERS.map(async (router) => {
      const c = new ethers.Contract(router.address, V2_ROUTER_ABI, provider);
      const amounts: bigint[] = await c.getAmountsIn(amountOut, path);
      return { router, requiredIn: amounts[0] };
    })
  );

  const successful = quotes
    .filter((r): r is PromiseFulfilledResult<RouterQuote> => r.status === "fulfilled")
    .map((r) => r.value);

  if (successful.length === 0) {
    throw new Error(
      "No AMM router could quote this swap. " +
      "Ensure a USDC/EURC liquidity pool exists on ArcSwap or UnitFlow."
    );
  }

  return successful.reduce((best, cur) => (cur.requiredIn < best.requiredIn ? cur : best));
}

// ── Core swap logic ───────────────────────────────────────────────────────────

async function executeSwap(
  signer: ethers.Signer,
  tokenIn: Currency,
  tokenOut: Currency,
  amountOut: bigint,
  recipient: string,
  deadline: number
): Promise<SwapResult> {
  const provider = signer.provider!;
  const path = [currencyToAddress(tokenIn), currencyToAddress(tokenOut)];

  const { router: bestRouter, requiredIn } = await getBestRouter(provider, amountOut, path);
  const amountInMax = requiredIn * 101n / 100n;

  // Approve router MaxUint256 on first use — skipped on every subsequent payment
  const tokenContract = new ethers.Contract(currencyToAddress(tokenIn), ERC20_ABI, signer);
  const signerAddr = await signer.getAddress();
  const currentAllowance: bigint = await tokenContract.allowance(signerAddr, bestRouter.address);
  if (currentAllowance < amountInMax) {
    const approveTx = await tokenContract.approve(bestRouter.address, ethers.MaxUint256);
    await approveTx.wait();
  }

  const routerContract = new ethers.Contract(bestRouter.address, V2_ROUTER_ABI, signer);
  const tx = await routerContract.swapTokensForExactTokens(
    amountOut,
    amountInMax,
    path,
    recipient,
    deadline
  );
  const receipt = await tx.wait();
  if (receipt?.status === 0) {
    throw new Error(`Swap reverted on ${bestRouter.name}`);
  }

  return {
    tokenIn,
    tokenOut,
    amountIn: toHumanAmountGeneric(requiredIn, currencyDecimals(tokenIn)),
    amountOutRaw: amountOut.toString(),
    txHash: tx.hash,
    explorerUrl: `${ARC_EXPLORER}/tx/${tx.hash}`,
  };
}

// ── Server-side swap (private key) ───────────────────────────────────────────

// ── Read-only estimate (no signer, no tx): how much tokenIn is required
// for the recipient to receive exactly amountOut of tokenOut. Same routing
// rule as the real swap (best of ArcSwap/UnitFlow, direct pair), so what a
// UI validates against is what execution would actually charge — before the
// 1% slippage cap. Throws if no router can quote the pair.
export async function estimateRequiredIn(
  provider: ethers.Provider,
  tokenIn: Currency,
  tokenOut: Currency,
  amountOut: bigint
): Promise<bigint> {
  const path = [currencyToAddress(tokenIn), currencyToAddress(tokenOut)];
  const { requiredIn } = await getBestRouter(provider, amountOut, path);
  return requiredIn;
}

export async function swap(
  privateKey: string,
  tokenIn: Currency,
  tokenOut: Currency,
  amountIn: string,
  _kitKey?: string
): Promise<SwapResult> {
  const provider = new ethers.JsonRpcProvider(ARC_RPC, {
    chainId: ARC_CHAIN_ID,
    name: "arc-testnet",
  });
  const wallet = new ethers.Wallet(privateKey, provider);
  const signerAddr = await wallet.getAddress();
  // amountIn here is the human-readable amount of tokenOut the recipient must
  // receive (an exact-output swap) — decimals come from tokenOut, not tokenIn.
  const amountOut = fromHumanAmountGeneric(amountIn, currencyDecimals(tokenOut));
  const deadline = Math.floor(Date.now() / 1000) + 300;

  return executeSwap(wallet, tokenIn, tokenOut, amountOut, signerAddr, deadline);
}

// ── Browser-side swap (EIP-1193 provider / MetaMask) ─────────────────────────

export async function swapWithBrowserWallet(
  eip1193Provider: unknown,
  tokenIn: Currency,
  tokenOut: Currency,
  amountIn: string,
  _kitKey?: string,
  _proxyBase?: string
): Promise<SwapResult> {
  const provider = new ethers.BrowserProvider(eip1193Provider as ethers.Eip1193Provider);
  const signer = await provider.getSigner();
  const signerAddr = await signer.getAddress();
  const amountOut = fromHumanAmountGeneric(amountIn, currencyDecimals(tokenOut));
  const deadline = Math.floor(Date.now() / 1000) + 300;

  return executeSwap(signer, tokenIn, tokenOut, amountOut, signerAddr, deadline);
}
