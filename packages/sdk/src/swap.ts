// Cross-currency swap via Arc testnet AMMs.
//
// Routers queried (best price wins):
//   1. ArcSwap  — Uniswap V2 by Arc Foundation
//                 Router:  0x48a9bd1644ac67fbef4183261c466bea3eb333fc
//   2. UnitFlow — V2.5 AMM (Uniswap V2-compatible)
//                 Router:  0x4AA8c7Ac458479d9A4FA5c1481e03061ac76824A
//
// Approval strategy (EIP-2612 permit):
//   First use:  signTypedData (off-chain, gasless) → StableFXAdapter.swapWithPermit
//               Sets MaxUint256 allowance in the same tx as the swap.
//   Subsequent: allowance already MaxUint256 → StableFXAdapter.swapDirect (no sign needed)
//
// Wallet interactions:
//   First cross-currency payment:  1 sign (permit) + 1 swap tx = 2 total
//   Subsequent cross-currency:     1 swap tx = 1 total
//
// If the token does not support EIP-2612, falls back to a regular approve tx.

import { ethers } from "ethers";
import { ARC_TESTNET } from "./constants.js";
import type { Currency } from "./types.js";

const ARC_RPC = "https://rpc.testnet.arc.network";
const ARC_CHAIN_ID = 5042002;
const ARC_EXPLORER = "https://testnet.arcscan.app";

const USDC = "0x3600000000000000000000000000000000000000";
const EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";

const STABLEFX_ADAPTER = ARC_TESTNET.contracts.stableFXAdapter;

interface RouterConfig { name: string; address: string }

const ROUTERS: RouterConfig[] = [
  { name: "ArcSwap",  address: "0x48a9bd1644ac67fbef4183261c466bea3eb333fc" },
  { name: "UnitFlow", address: "0x4AA8c7Ac458479d9A4FA5c1481e03061ac76824A" },
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function name() view returns (string)",
  "function nonces(address owner) view returns (uint256)",
  "function version() view returns (string)",
];

const V2_ROUTER_ABI = [
  "function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
  "function getAmountsIn(uint amountOut, address[] calldata path) external view returns (uint[] memory amounts)",
];

const ADAPTER_ABI = [
  "function swapWithPermit(address tokenIn, uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s, address tokenOut, uint256 amountOut, uint256 amountInMax, address router, uint256 swapDeadline) external",
  "function swapDirect(address tokenIn, address tokenOut, uint256 amountOut, uint256 amountInMax, address router, uint256 swapDeadline) external",
];

const PERMIT_TYPES = [
  { name: "owner",    type: "address" },
  { name: "spender",  type: "address" },
  { name: "value",    type: "uint256" },
  { name: "nonce",    type: "uint256" },
  { name: "deadline", type: "uint256" },
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

// ── EIP-2612 permit helper ────────────────────────────────────────────────────

interface PermitSig { v: number; r: string; s: string; deadline: number }

// Returns a signed permit if allowance is insufficient, or null if already approved.
// Falls back to a regular approve tx if the token does not support EIP-2612.
async function signPermitOrApprove(
  signer: ethers.Signer,
  tokenAddr: string,
  owner: string,
  amountNeeded: bigint
): Promise<PermitSig | null> {
  const token = new ethers.Contract(tokenAddr, ERC20_ABI, signer);
  const allowance: bigint = await token.allowance(owner, STABLEFX_ADAPTER);
  if (allowance >= amountNeeded) return null; // already approved — no permit needed

  const deadline = Math.floor(Date.now() / 1000) + 600; // 10 min window for signing

  try {
    const nonce: bigint = await token.nonces(owner);
    const tokenName: string = await token.name();
    let version = "2"; // Circle tokens (USDC, EURC) use version 2
    try { version = await token.version(); } catch { /* not all tokens expose version() */ }

    const sig = await signer.signTypedData(
      { name: tokenName, version, chainId: ARC_CHAIN_ID, verifyingContract: tokenAddr },
      { Permit: PERMIT_TYPES },
      {
        owner,
        spender: STABLEFX_ADAPTER,
        value: ethers.MaxUint256,
        nonce,
        deadline: BigInt(deadline),
      }
    );

    const { v, r, s } = ethers.Signature.from(sig);
    return { v, r, s, deadline };
  } catch {
    // Token does not support EIP-2612 — fall back to a regular approve tx
    const tx = await token.approve(STABLEFX_ADAPTER, ethers.MaxUint256);
    await tx.wait();
    return null; // allowance now set via approve, swapDirect will work
  }
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
  const tokenInAddr = currencyToAddress(tokenIn);
  const tokenOutAddr = currencyToAddress(tokenOut);
  const path = [tokenInAddr, tokenOutAddr];

  // Get best-price router
  const { router: bestRouter, requiredIn } = await getBestRouter(provider, amountOut, path);
  const amountInMax = requiredIn * 101n / 100n; // 1% slippage

  const signerAddr = await signer.getAddress();

  // Get permit signature (or approve if permit unsupported)
  const permit = await signPermitOrApprove(signer, tokenInAddr, signerAddr, amountInMax);

  // Execute via StableFXAdapter — handles permit, pull, swap, refund in one tx
  const adapter = new ethers.Contract(STABLEFX_ADAPTER, ADAPTER_ABI, signer);

  let tx;
  if (permit) {
    // First use: permit was just signed — call swapWithPermit (sets MaxUint256 allowance + swaps)
    tx = await adapter.swapWithPermit(
      tokenInAddr, permit.deadline, permit.v, permit.r, permit.s,
      tokenOutAddr, amountOut, amountInMax,
      bestRouter.address, deadline
    );
  } else {
    // Subsequent use: allowance already MaxUint256 — skip permit entirely
    tx = await adapter.swapDirect(
      tokenInAddr, tokenOutAddr, amountOut, amountInMax,
      bestRouter.address, deadline
    );
  }

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

function currencyToAddress(currency: Currency): string {
  return currency === "USDC" ? USDC : EURC;
}
