// Cross-currency swap via Arc testnet AMMs.
//
// Routers queried (best price wins):
//   1. ArcSwap  — Uniswap V2 by Arc Foundation
//                 Router:  0x48a9bd1644ac67fbef4183261c466bea3eb333fc
//                 Factory: 0x45dd35611179ae6663ae47791175d7d598ced086
//   2. UnitFlow — V2.5 AMM (Uniswap V2-compatible)
//                 Router:  0x4AA8c7Ac458479d9A4FA5c1481e03061ac76824A
//                 Factory: 0xd67F63A4F26a497b364d1C82e6747Aec8B5743a5
//
// Synthra (V3 fork) is deployed on Arc testnet but its contract addresses are
// not publicly documented — add here if/when they become available.
//
// Uses swapTokensForExactTokens — recipient always receives the exact declared
// amount. Payer's max input = getAmountsIn(amountOut) * 1.01 (1% slippage cap).

import { ethers } from "ethers";
import type { Currency } from "./types.js";

const ARC_RPC = "https://rpc.testnet.arc.network";
const ARC_CHAIN_ID = 5042002;
const ARC_EXPLORER = "https://testnet.arcscan.app";

const USDC = "0x3600000000000000000000000000000000000000";
const EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";

interface RouterConfig {
  name: string;
  address: string;
}

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

interface RouterQuote {
  router: RouterConfig;
  requiredIn: bigint;
}

async function getBestRouter(
  provider: ethers.Provider,
  amountOut: bigint,
  path: string[]
): Promise<RouterQuote> {
  const quotes = await Promise.allSettled(
    ROUTERS.map(async (router) => {
      const contract = new ethers.Contract(router.address, V2_ROUTER_ABI, provider);
      const amounts: bigint[] = await contract.getAmountsIn(amountOut, path);
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

  // Pick router with lowest required input (best rate for payer)
  return successful.reduce((best, cur) => (cur.requiredIn < best.requiredIn ? cur : best));
}

// ── Core swap logic ───────────────────────────────────────────────────────────

// amountOut:  exact base-unit amount the recipient receives (e.g. 1_000_000n = 1 EURC)
// recipient:  address that receives the output tokens
// deadline:   unix timestamp after which the swap reverts on-chain
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

  // Query all routers and pick best price
  const { router: bestRouter, requiredIn } = await getBestRouter(provider, amountOut, path);

  // 1% slippage tolerance on input
  const amountInMax = requiredIn * 101n / 100n;

  // Approve router if allowance is insufficient
  const tokenContract = new ethers.Contract(currencyToAddress(tokenIn), ERC20_ABI, signer);
  const signerAddr = await signer.getAddress();
  const currentAllowance: bigint = await tokenContract.allowance(signerAddr, bestRouter.address);
  if (currentAllowance < amountInMax) {
    const approveTx = await tokenContract.approve(bestRouter.address, ethers.MaxUint256);
    await approveTx.wait();
  }

  // Execute exact-output swap on the best router
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
    amountIn: toHumanAmount(requiredIn),
    amountOutRaw: amountOut.toString(),
    txHash: tx.hash,
    explorerUrl: `${ARC_EXPLORER}/tx/${tx.hash}`,
  };
}

// ── Server-side swap (private key) ───────────────────────────────────────────
//
// amountIn:  human-readable exact output amount the recipient must receive
//            (e.g. "1.00" for 1 EURC). Payer input is getAmountsIn + 1% slippage.
// _kitKey:   unused — kept for API compatibility

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
  const amountOut = fromHumanAmount(amountIn);
  const deadline = Math.floor(Date.now() / 1000) + 300; // 5 min

  return executeSwap(wallet, tokenIn, tokenOut, amountOut, signerAddr, deadline);
}

// ── Browser-side swap (EIP-1193 provider / MetaMask) ─────────────────────────
//
// amountIn:   human-readable exact output amount the recipient must receive
// _kitKey:    unused
// _proxyBase: unused

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
  const amountOut = fromHumanAmount(amountIn);
  const deadline = Math.floor(Date.now() / 1000) + 300; // 5 min

  return executeSwap(signer, tokenIn, tokenOut, amountOut, signerAddr, deadline);
}

// ── Amount helpers ────────────────────────────────────────────────────────────

export function toHumanAmount(amount: bigint): string {
  const divisor = 1_000_000n;
  const whole = amount / divisor;
  const frac = (amount % divisor).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}.00`;
}

export function fromHumanAmount(amount: string): bigint {
  const [whole = "0", frac = ""] = amount.split(".");
  const paddedFrac = frac.slice(0, 6).padEnd(6, "0");
  return BigInt(whole) * 1_000_000n + BigInt(paddedFrac || "0");
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function currencyToAddress(currency: Currency): string {
  return currency === "USDC" ? USDC : EURC;
}
