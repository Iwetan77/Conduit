import type { Eip1193Provider } from "ethers";

// Must match packages/api/internal/handlers/wallet_history.go's
// walletHistoryMessage() byte-for-byte -- the server reconstructs this same
// string from (wallet, timestamp) and checks the signature against it, so
// nothing here is ever sent as free text the server has to trust.
function walletHistoryMessage(wallet: string, timestamp: number): string {
  return `Conduit: view payment history\n\nWallet: ${wallet.toLowerCase()}\nTimestamp: ${timestamp}`;
}

// The server accepts a signature for 10 minutes from its timestamp; reuse one
// for 8 to leave a safety margin against clock skew and slow requests near
// the edge, rather than re-prompting a wallet signature on every single visit
// to /history. sessionStorage (not localStorage): this is a capability, not
// an identity -- it shouldn't outlive the tab, and a stale one is harmless
// since it just expires server-side and gets replaced.
const CACHE_KEY = "conduit.walletHistorySig";
const VALIDITY_SECONDS = 8 * 60;

interface CachedSig {
  wallet: string;
  timestamp: number;
  signature: string;
}

function readCache(wallet: string): CachedSig | null {
  try {
    const raw = window.sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedSig;
    if (cached.wallet.toLowerCase() !== wallet.toLowerCase()) return null;
    if (Math.floor(Date.now() / 1000) - cached.timestamp > VALIDITY_SECONDS) return null;
    return cached;
  } catch {
    return null;
  }
}

// Signs the fixed history-viewing message with the connected wallet's own
// provider (personal_sign / eth_sign, via ethers' signMessage — NOT
// signTypedData, since this is plain text, not a StableFX payload) -- unless
// a still-fresh signature for this wallet is already cached for this tab, in
// which case that's reused and the wallet is never prompted at all.
export async function signWalletHistoryRequest(
  wallet: string,
  provider: Eip1193Provider
): Promise<{ timestamp: number; signature: string }> {
  const cached = readCache(wallet);
  if (cached) return { timestamp: cached.timestamp, signature: cached.signature };

  const { ethers } = await import("ethers");
  const { browserProviderFrom } = await import("@/lib/wallet-provider");
  const timestamp = Math.floor(Date.now() / 1000);
  const message = walletHistoryMessage(wallet, timestamp);
  const browserProvider = await browserProviderFrom(provider);
  const signer = await browserProvider.getSigner();
  const signature = await signer.signMessage(message);

  try {
    window.sessionStorage.setItem(CACHE_KEY, JSON.stringify({ wallet, timestamp, signature }));
  } catch {
    // Storage can fail (private browsing, quota) -- non-fatal, just means
    // the next visit signs again.
  }

  return { timestamp, signature };
}
