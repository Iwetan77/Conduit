// Solana wallet access for the cross-chain (Circle UBK) pay path.
//
// Circle's Unified Balance Kit owns ALL the signing itself: we hand its
// createSolanaAdapterFromProvider() the injected wallet provider, and the SDK
// reads balances, deposits, and spends through it. So the only thing this file
// still does is FIND and CONNECT the wallet. (The old signBurnIntent /
// signAndSubmitDeposit helpers here were from the pre-UBK approach where we
// hand-encoded and signed Solana ourselves; UBK replaced them, so they're
// deleted.)
import type { Transaction } from "@solana/web3.js";

interface SolanaProvider {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect(): Promise<{ publicKey: { toString(): string } }>;
  signTransaction(tx: Transaction): Promise<Transaction>;
  signMessage(message: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array }>;
}

// Accept any injected Solana wallet that can sign transactions -- not just
// Phantom. This matters for Circle Gateway: the burn-intent authorization is
// signed via signMessage, and PHANTOM SPECIFICALLY refuses to signMessage a
// transaction-shaped payload ("you cannot sign solana transactions using sign
// message"). That block lives in the Phantom extension, not in our code or any
// library we ship, so it can't be patched here. Circle lists Phantom, Solflare
// and Backpack as supported, and Solflare/Backpack don't apply that block --
// so prefer them when present, and fall back to window.solana otherwise.
export function getSolanaProvider(): SolanaProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    solana?: SolanaProvider;
    solflare?: SolanaProvider;
    backpack?: SolanaProvider;
  };
  const candidate = w.solflare ?? w.backpack ?? w.solana;
  return candidate && typeof candidate.signTransaction === "function" ? candidate : null;
}

export async function connectSolanaWallet(): Promise<string> {
  const provider = getSolanaProvider();
  if (!provider) {
    throw new Error("No Solana wallet found. Install Solflare, Backpack or Phantom to pay from Solana.");
  }
  const { publicKey } = await provider.connect();
  return publicKey.toString();
}
