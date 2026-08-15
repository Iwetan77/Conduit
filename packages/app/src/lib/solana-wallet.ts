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

// Every Solana wallet the browser actually has, discovered rather than guessed.
//
// Two earlier versions of this were wrong in the same way. The first picked one
// wallet by a fixed preference order (solflare ?? backpack ?? window.solana)
// and returned it, so a payer with two installed got whichever our ordering
// favoured. The second listed those same three by name, which is no better: it
// silently excludes Glow, Coinbase, Trust, and anything shipped next month.
//
// The right answer is the one wagmi already gives us on the EVM side. EIP-6963
// is how an EVM wallet announces itself instead of fighting over
// window.ethereum; the Solana ecosystem's equivalent is the Wallet Standard,
// where each wallet registers itself and reports its own name, icon, chains and
// features. Ask the registry and the list is whatever the payer actually has,
// with no names hardcoded anywhere.
//
// Circle's adapter still wants a legacy injected provider object
// (createSolanaAdapterFromProvider({ provider: window.solana })), not a
// Wallet Standard wallet, so the registry is used for DISCOVERY and each entry
// is paired with the injected object that wallet also exposes. The window scan
// that does the pairing is generic: it looks for the provider SHAPE rather than
// for known keys, so a wallet at window.glow or window.trustwallet is found
// without being named here.
export interface SolanaWalletOption {
  /** Stable key for React lists. The wallet's own name, lowercased. */
  id: string;
  label: string;
  /** Data URI from the wallet itself, when it registered one. */
  icon?: string;
  provider: SolanaProvider;
  /** False for wallets that refuse Circle Gateway's signMessage payload. */
  gatewayCapable: boolean;
}

// Phantom refuses to signMessage a transaction-shaped payload ("you cannot sign
// solana transactions using sign message"), which is exactly how Circle Gateway
// authorises a burn intent. That block lives in the Phantom extension, so it
// cannot be patched here or in any library we ship.
//
// This is a known-limitation ANNOTATION, not the enumeration. Phantom is listed
// like everything else and simply labelled, so a payer who has it sees why it
// will not work instead of picking it and failing at the signature. Any wallet
// not on this list is assumed to work, which is the right default: the failure
// is loud and recoverable, whereas hiding wallets is silent.
const CANNOT_SIGN_GATEWAY = [/phantom/i];

function looksLikeProvider(v: unknown): v is SolanaProvider {
  const p = v as SolanaProvider | undefined;
  return (
    !!p &&
    typeof p === "object" &&
    typeof p.connect === "function" &&
    typeof p.signTransaction === "function"
  );
}

// Injected provider objects anywhere on window, found by shape.
//
// Wallets expose these under their own key (window.solflare, window.backpack),
// under window.solana if they won the injection race, or nested one level down
// (window.phantom.solana). Scanning beats a key list because the key list is
// exactly what keeps being incomplete.
function injectedProviders(): { key: string; provider: SolanaProvider }[] {
  const out: { key: string; provider: SolanaProvider }[] = [];
  const seen = new Set<unknown>();
  const add = (key: string, v: unknown) => {
    if (looksLikeProvider(v) && !seen.has(v)) {
      seen.add(v);
      out.push({ key, provider: v });
    }
  };

  for (const key of Object.keys(window)) {
    let value: unknown;
    try {
      value = (window as unknown as Record<string, unknown>)[key];
    } catch {
      // Some window properties throw on access (cross-origin frames). Skip.
      continue;
    }
    add(key, value);
    // One level down, for the window.phantom.solana / window.glow.solana shape.
    if (value && typeof value === "object" && !looksLikeProvider(value)) {
      const nested = (value as Record<string, unknown>).solana;
      if (nested) add(key, nested);
    }
  }
  return out;
}

export function listSolanaWallets(): SolanaWalletOption[] {
  if (typeof window === "undefined") return [];

  const injected = injectedProviders();
  const used = new Set<SolanaProvider>();
  const out: SolanaWalletOption[] = [];

  // Registered wallets first: they carry a real name and icon, straight from
  // the wallet rather than inferred by us.
  for (const wallet of registeredSolanaWallets()) {
    const name = wallet.name;
    // Pair by the wallet's own flags (isPhantom, isSolflare, ...) or by its key
    // on window, both matched against the registered name. A wallet that
    // registers but injects nothing cannot be handed to Circle's adapter, so it
    // is skipped rather than listed and then failing on selection.
    const match = injected.find(({ key, provider }) => {
      if (used.has(provider)) return false;
      const flag = `is${name.replace(/\s+/g, "")}`.toLowerCase();
      const flags = Object.keys(provider).filter((k) => k.startsWith("is"));
      return (
        key.toLowerCase() === name.toLowerCase().replace(/\s+/g, "") ||
        flags.some((f) => f.toLowerCase() === flag)
      );
    });
    if (!match) continue;
    used.add(match.provider);
    out.push({
      id: name.toLowerCase(),
      label: name,
      icon: wallet.icon,
      provider: match.provider,
      gatewayCapable: !CANNOT_SIGN_GATEWAY.some((re) => re.test(name)),
    });
  }

  // Anything injected that did not register, or that we could not pair. Named
  // from its own flag when it has one, so an unregistered wallet still shows up
  // as something a payer recognises rather than being dropped.
  for (const { key, provider } of injected) {
    if (used.has(provider)) continue;
    const flag = Object.keys(provider).find(
      (k) => k.startsWith("is") && (provider as unknown as Record<string, unknown>)[k] === true
    );
    const raw = flag ? flag.slice(2) : key === "solana" ? "" : key;
    const label = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "Injected Solana wallet";
    out.push({
      id: (raw || key).toLowerCase(),
      label,
      provider,
      gatewayCapable: !CANNOT_SIGN_GATEWAY.some((re) => re.test(label)),
    });
  }

  return out;
}

// The Wallet Standard registry, read lazily so the package is only pulled into
// the bundle where cross-chain pay is actually used.
function registeredSolanaWallets(): { name: string; icon?: string }[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getWallets } = require("@wallet-standard/app") as {
      getWallets: () => { get: () => readonly { name: string; icon?: string; chains: readonly string[] }[] };
    };
    return getWallets()
      .get()
      .filter((w) => w.chains.some((c) => c.startsWith("solana:")))
      .map((w) => ({ name: w.name, icon: w.icon }));
  } catch {
    // No registry (older wallets, or the package failed to load): the injected
    // scan below still finds everything that matters.
    return [];
  }
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
