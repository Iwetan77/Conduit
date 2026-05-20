// Cross-currency swap via ArcSwap Uniswap V2 (Arc Foundation deployment).
//
// Router: 0x48a9bd1644ac67fbef4183261c466bea3eb333fc (Arc Testnet, chain 5042002)
// Factory: 0x45dd35611179ae6663ae47791175d7d598ced086
// Source: https://arcswap.net/docs — official Arc Foundation Uniswap V2 deploy.
//
// Uses swapTokensForExactTokens so the recipient always receives the exact declared
// amount. Payer's maximum input = getAmountsIn(amountOut) * 1.01 (1% slippage cap).
//
// Circle StableFX API (both institutional stablefx and stablecoinKits) removed:
//   - v1/exchange/stablefx  → requires institutional KYB/AML onboarding
//   - v1/stablecoinKits/swap → returns no instructions for Arc USDC/EURC swaps

import { ethers } from "ethers";
import type { Currency } from "./types.js";

const ARC_RPC = "https://rpc.testnet.arc.network";
const ARC_CHAIN_ID = 5042002;
const ARC_EXPLORER = "https://testnet.arcscan.app";

const USDC = "0x3600000000000000000000000000000000000000";
const EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";

// ArcSwap Uniswap V2 — deployed by Arc Foundation
const AMM_ROUTER = "0x48a9bd1644ac67fbef4183261c466bea3eb333fc";

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

// ── Core swap logic ───────────────────────────────────────────────────────────

// amountOut: exact base-unit amount the recipient must receive (e.g. 1_000_000n = 1 EURC)
// recipient: address that receives the output tokens (usually the signer's address)
async function executeSwap(
  signer: ethers.Signer,
  tokenIn: Currency,
  tokenOut: Currency,
  amountOut: bigint,
  recipient: string,
  deadline: number
): Promise<SwapResult> {
  const router = new ethers.Contract(AMM_ROUTER, V2_ROUTER_ABI, signer);
  const path = [currencyToAddress(tokenIn), currencyToAddress(tokenOut)];

  // Query required input from router
  const amounts: bigint[] = await router.getAmountsIn(amountOut, path);
  const requiredIn = amounts[0];

  // 1% slippage on input side
  const amountInMax = requiredIn * 101n / 100n;

  // Approve router if needed
  const tokenContract = new ethers.Contract(currencyToAddress(tokenIn), ERC20_ABI, signer);
  const signerAddr = await signer.getAddress();
  const currentAllowance: bigint = await tokenContract.allowance(signerAddr, AMM_ROUTER);
  if (currentAllowance < amountInMax) {
    const approveTx = await tokenContract.approve(AMM_ROUTER, ethers.MaxUint256);
    await approveTx.wait();
  }

  // Execute exact-output swap
  const tx = await router.swapTokensForExactTokens(
    amountOut,
    amountInMax,
    path,
    recipient,
    deadline
  );
  const receipt = await tx.wait();
  if (receipt?.status === 0) {
    throw new Error("Swap transaction reverted on-chain");
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
// amountIn: human-readable exact output amount the recipient must receive
//           (e.g. "1.00" for 1 EURC). Input is computed via getAmountsIn + 1% slippage.
// kitKey:   unused — kept for API compatibility with existing callers

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
  const deadline = Math.floor(Date.now() / 1000) + 300;

  return executeSwap(wallet, tokenIn, tokenOut, amountOut, signerAddr, deadline);
}

// ── Browser-side swap (EIP-1193 provider / MetaMask) ─────────────────────────
//
// amountIn:  human-readable exact output amount the recipient must receive
// _kitKey:   unused
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
  const deadline = Math.floor(Date.now() / 1000) + 300;

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
