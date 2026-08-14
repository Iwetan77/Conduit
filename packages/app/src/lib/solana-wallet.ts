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
  isSolflare?: boolean;
  isBackpack?: boolean;
  disconnect?: () => Promise<void>;
  publicKey?: { toString(): string } | null;
  // Phantom resolves connect() to { publicKey }; Solflare resolves it WITHOUT
  // a return value and instead populates provider.publicKey. Type the return as
  // optional so we never assume Phantom's shape.
  connect(): Promise<{ publicKey?: { toString(): string } } | void>;
  signTransaction(tx: Transaction): Promise<Transaction>;
  signMessage(message: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array }>;
}

// Every injected Solana wallet the browser actually has, so the payer can
// CHOOSE one.
//
// This used to be a single getSolanaProvider() that picked with a fixed
// preference order (solflare ?? backpack ?? window.solana) and returned it.
// That is wrong for the same reason it would be wrong on the EVM side: the
// payer owns the decision about which of their wallets spends their money, and
// a payer with two installed got whichever one our ordering happened to favour,
// with no way to switch and no way to disconnect.
//
// The Phantom note is still worth carrying, because it is not a preference but
// a hard limitation: Circle Gateway authorises a burn intent via signMessage on
// a transaction-shaped payload, and PHANTOM SPECIFICALLY refuses that ("you
// cannot sign solana transactions using sign message"). The block lives in the
// Phantom extension, so it cannot be patched here or in any library we ship.
// Solflare and Backpack do not apply it. Hence `gatewayCapable` below: Phantom
// is offered, because hiding a wallet someone has installed is its own kind of
// broken, but it is labelled rather than silently chosen and then failed on.
export interface SolanaWalletOption {
  id: "solflare" | "backpack" | "phantom";
  label: string;
  provider: SolanaProvider;
  /** False for wallets that refuse Circle Gateway's signMessage payload. */
  gatewayCapable: boolean;
}

export function listSolanaWallets(): SolanaWalletOption[] {
  if (typeof window === "undefined") return [];
  const w = window as unknown as {
    solana?: SolanaProvider;
    solflare?: SolanaProvider;
    backpack?: SolanaProvider;
  };
  const signs = (p?: SolanaProvider) => !!p && typeof p.signTransaction === "function";

  const out: SolanaWalletOption[] = [];
  if (signs(w.solflare)) {
    out.push({ id: "solflare", label: "Solflare", provider: w.solflare!, gatewayCapable: true });
  }
  if (signs(w.backpack)) {
    out.push({ id: "backpack", label: "Backpack", provider: w.backpack!, gatewayCapable: true });
  }
  // window.solana is whichever wallet won the injection race, which is usually
  // Phantom but is not guaranteed to be. Only add it when it is not already
  // listed above under its own name.
  const generic = w.solana;
  if (signs(generic) && generic !== w.solflare && generic !== w.backpack) {
    const isPhantom = !!generic!.isPhantom;
    out.push({
      id: "phantom",
      label: isPhantom ? "Phantom" : "Injected Solana wallet",
      provider: generic!,
      gatewayCapable: !isPhantom,
    });
  }
  return out;
}

/** The wallet the payer picked, for this page's lifetime. */
let selected: SolanaProvider | null = null;

export function getSolanaProvider(): SolanaProvider | null {
  if (selected) return selected;
  // No explicit choice yet: fall back to the first detected wallet so callers
  // that only read (balances) still work before the payer has picked.
  return listSolanaWallets()[0]?.provider ?? null;
}

export async function disconnectSolanaWallet(): Promise<void> {
  const p = selected;
  selected = null;
  // Not every wallet implements disconnect, and a wallet that refuses to
  // disconnect must not break the UI -- the local choice is cleared either way,
  // which is what actually lets the payer pick a different one.
  try {
    await p?.disconnect?.();
  } catch {
    // Ignored deliberately; see above.
  }
}

export async function connectSolanaWallet(choice?: SolanaProvider): Promise<string> {
  const provider = choice ?? getSolanaProvider();
  if (!provider) {
    throw new Error("No Solana wallet found. Install Solflare, Backpack or Phantom to pay from Solana.");
  }
  // Remember it, so every later call (balance reads, the UBK adapter, the
  // signature) uses the wallet the payer actually chose rather than re-running
  // detection and possibly landing on a different one.
  selected = provider;
  // Read the address off the provider, not the connect() return: Solflare
  // resolves connect() with nothing and sets provider.publicKey instead, so
  // destructuring `{ publicKey }` from the result gave undefined and blew up on
  // `.toString()`. Both Phantom and Solflare populate provider.publicKey.
  const result = await provider.connect();
  const pk = provider.publicKey ?? result?.publicKey;
  if (!pk) {
    throw new Error("Wallet connected but returned no public key. Reopen the wallet and try again.");
  }
  return pk.toString();
}
