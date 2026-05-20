// Circle App Kit — cross-currency swap for Arc Testnet
// Arc Testnet is the ONLY testnet that supports USDC↔EURC swap.
//
// Get your Kit Key at https://console.circle.com → Keys → Kit Key
// Use @circle-fin/app-kit + @circle-fin/adapter-viem-v2

import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";
import type { Currency } from "./types.js";

export interface SwapResult {
  tokenIn: Currency;
  tokenOut: Currency;
  amountIn: string;       // human-readable input (e.g. "10.00")
  amountOutRaw?: string;  // base-unit string from kit (e.g. "9970000"), undefined if LI.FI lookup failed
  txHash: string;
  explorerUrl: string;
}

const kit = new AppKit();

// ── Server-side: swap via private key ─────────────────────────────────────────

export async function swap(
  privateKey: string,
  tokenIn: Currency,
  tokenOut: Currency,
  amountIn: string,
  kitKey: string
): Promise<SwapResult> {
  const adapter = createViemAdapterFromPrivateKey({ privateKey });

  const result = await kit.swap({
    from: { adapter, chain: "Arc_Testnet" },
    tokenIn,
    tokenOut,
    amountIn,
    config: { kitKey },
  });

  return {
    tokenIn,
    tokenOut,
    amountIn: result.amountIn,
    amountOutRaw: result.amountOut,
    txHash: result.txHash,
    explorerUrl: `https://testnet.arcscan.app/tx/${result.txHash}`,
  };
}

// ── Browser-side: swap via EIP-1193 provider ──────────────────────────────────
// Pass the raw EIP-1193 provider (window.ethereum or equivalent) — NOT an
// ethers.BrowserProvider. The client.ts helper getEip1193Provider() wraps the
// BrowserProvider into an EIP-1193 compatible object automatically.

export async function swapWithBrowserWallet(
  eip1193Provider: unknown,
  tokenIn: Currency,
  tokenOut: Currency,
  amountIn: string,
  kitKey: string,
  proxyBase = "/api/circle-proxy"
): Promise<SwapResult> {
  const { createViemAdapterFromProvider } = await import("@circle-fin/adapter-viem-v2");
  const adapter = await createViemAdapterFromProvider({
    provider: eip1193Provider as Parameters<typeof createViemAdapterFromProvider>[0]["provider"],
  });

  // Intercept Circle API calls from the kit and route them through our server proxy
  // to avoid CORS issues when called from the browser.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("api.circle.com")) {
      const path = url.replace(/^https?:\/\/api\.circle\.com\//, "");
      const proxyUrl = `${proxyBase}?path=${encodeURIComponent(path)}`;
      return originalFetch(proxyUrl, init);
    }
    return originalFetch(input, init);
  };

  let result;
  try {
    result = await kit.swap({
      from: { adapter, chain: "Arc_Testnet" },
      tokenIn,
      tokenOut,
      amountIn,
      config: { kitKey },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  return {
    tokenIn,
    tokenOut,
    amountIn: result.amountIn,
    amountOutRaw: result.amountOut,
    txHash: result.txHash,
    explorerUrl: `https://testnet.arcscan.app/tx/${result.txHash}`,
  };
}

// ── Amount helpers ────────────────────────────────────────────────────────────

// Convert 6-decimal bigint → human-readable string for kit.swap() amountIn param
export function toHumanAmount(amount: bigint): string {
  const divisor = 1_000_000n;
  const whole = amount / divisor;
  const frac = (amount % divisor).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}.00`;
}

// Convert human-readable string → 6-decimal bigint
export function fromHumanAmount(amount: string): bigint {
  const [whole = "0", frac = ""] = amount.split(".");
  const paddedFrac = frac.slice(0, 6).padEnd(6, "0");
  return BigInt(whole) * 1_000_000n + BigInt(paddedFrac || "0");
}
