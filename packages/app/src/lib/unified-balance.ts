// Client-side Circle Unified Balance Kit (UBK) integration.
//
// This is the "option B" architecture (see the cross-chain discussion): rather
// than the Go API hand-encoding a per-chain deposit tx + burn intent, the
// browser drives Circle's UBK SDK directly. The SDK's adapters own the
// chain-specific signing, so ONE code path here covers every supported source
// chain — EVM (Base, Polygon, …) via the connected EIP-1193 wallet and Solana
// via Phantom — and the "unified balance" is genuinely one spendable number
// across all of them.
//
// What this replaces: internal/bridge/gateway.go's Solana-specific encoding
// (buildSolanaDepositTx / encodeBurnIntentForSolana). The Go side keeps only
// the Gateway *status polling* + the existing StableFX settlement handoff
// (settleBridgedIntent) — that half is chain-agnostic and already works.
//
// Everything is dynamically imported: @circle-fin/* + viem + @solana/web3.js is
// heavy (~MBs) and must not land in the main /pay bundle for the majority of
// payers who never bridge. Only a payer who actually chooses "pay with USDC
// from another chain" downloads it.

// UBK deals in HUMAN decimal strings ("11.13"), not minor units. Conduit deals
// in minor-unit bigints everywhere else, so conversion happens only at this
// boundary. USDC is 6dp on every chain Gateway supports.
const USDC_DECIMALS = 6;

// Testnet chain identifiers, exactly as UBK's Blockchain enum spells them
// (verified against the shipped index.d.cts). Arc is the settlement
// destination; the rest are payer source chains.
export const ARC_CHAIN = "Arc_Testnet";
// Every chain Circle Gateway supports, keyed by the slug the API's
// report_spend expects (see sourceDomainFor in bridge.go -- the two lists must
// stay in step). Chain ids are the SDK's own Blockchain enum spellings. We
// previously wired only 3 of these, so a payer holding USDC on Arbitrum or
// Avalanche was told they had none.
export const SOURCE_CHAINS = {
  solana: "Solana_Devnet",
  base: "Base_Sepolia",
  polygon: "Polygon_Amoy_Testnet",
  ethereum: "Ethereum_Sepolia",
  avalanche: "Avalanche_Fuji",
  optimism: "Optimism_Sepolia",
  arbitrum: "Arbitrum_Sepolia",
  unichain: "Unichain_Sepolia",
  sonic: "Sonic_Testnet",
  worldchain: "World_Chain_Sepolia",
  sei: "Sei_Testnet",
  hyperevm: "HyperEVM_Testnet",
} as const;

// Human labels for the chains above, for anything that shows a payer where
// their balance actually sits.
export const SOURCE_CHAIN_LABELS: Record<SourceKind, string> = {
  solana: "Solana",
  base: "Base",
  polygon: "Polygon",
  ethereum: "Ethereum",
  avalanche: "Avalanche",
  optimism: "Optimism",
  arbitrum: "Arbitrum",
  unichain: "Unichain",
  sonic: "Sonic",
  worldchain: "World Chain",
  sei: "Sei",
  hyperevm: "HyperEVM",
};

export type SourceKind = keyof typeof SOURCE_CHAINS;

// An opaque handle to a built UBK adapter (the SDK's adapter type is deeply
// generic; callers never need its shape, only to pass it back in).
export interface PayerAdapter {
  adapter: unknown;
  /** The payer's address on the wallet that built this adapter. */
  address: string;
  /** "evm" adapters can source from every EVM chain; "solana" only Solana. */
  family: "evm" | "solana";
  /**
   * The raw EIP-1193 provider this adapter was built over. Kept because
   * depositing from a given EVM chain requires the WALLET to be on that chain
   * (viem rejects it otherwise: "chainId should be same as current chainId"),
   * and switching networks needs the provider, not the SDK adapter.
   */
  provider?: unknown;
}

export interface ChainUsdc {
  chain: string;
  /**
   * Everything spendable on this chain, human string, e.g. "11.130000".
   *
   * The sum of `gateway` and `wallet` below. Kept as the headline number
   * because it is what a payer's balance actually is; the split matters only
   * to the machinery that has to move it.
   */
  confirmed: string;
  /**
   * Already deposited into Circle Gateway.
   *
   * Spendable with an off-chain signature and nothing else -- no transaction,
   * no gas, and it pools with every other chain's Gateway balance into one
   * amount (see spendUsdcToArc).
   */
  gateway?: string;
  /**
   * Sitting in the wallet on this chain.
   *
   * Equally spendable, but not for free: it has to be deposited into Gateway
   * first, and a deposit is an on-chain transaction ON THIS CHAIN -- approve
   * plus deposit, paying that chain's gas, and for an EVM wallet a network
   * switch to get there. That is the one part of the unified balance that
   * cannot be unified, so it is tracked separately rather than averaged into
   * a single figure that hides the cost.
   */
  wallet?: string;
}

export interface UnifiedUsdc {
  /** Total spendable across all chains, human string. */
  totalConfirmed: string;
  byChain: ChainUsdc[];
}

/** The gateway/wallet split of a chain entry, in minor units. */
export function splitOf(c: ChainUsdc): { gateway: bigint; wallet: bigint; total: bigint } {
  const gateway = usdcHumanToMinor(c.gateway ?? "0");
  const wallet = usdcHumanToMinor(c.wallet ?? "0");
  const total = usdcHumanToMinor(c.confirmed);
  // Older entries carry only `confirmed`. Attributing an unlabelled balance to
  // the wallet is the safe default: it plans a deposit that then turns out to be
  // unnecessary, rather than skipping one that was required and failing at the
  // spend with "insufficient balance".
  if (gateway === 0n && wallet === 0n) return { gateway: 0n, wallet: total, total };
  return { gateway, wallet, total };
}

// Conduit runs entirely on Circle testnets (Arc_Testnet, Base_Sepolia, …).
// UBK defaults to MAINNET when a source is adapter-only with no explicit
// chains, so every balance/spend call MUST pin networkType — otherwise the
// SDK queries mainnet Gateway and reports the payer holds nothing.
const NETWORK: "testnet" = "testnet";
const TOKEN: "USDC" = "USDC";

let contextSingleton: unknown = null;
async function context() {
  if (contextSingleton) return contextSingleton;
  const { createUnifiedBalanceKitContext } = await import("@circle-fin/unified-balance-kit");
  contextSingleton = createUnifiedBalanceKitContext();
  return contextSingleton;
}

// Convert a minor-unit bigint (6dp USDC) to the human decimal string UBK wants.
// Display formatting for USDC amounts. usdcMinorToHuman below always emits all
// 6 decimals because Circle's SDK needs that exact precision -- but showing a
// payer "Pay 5.000000 USDC" is machine output, not money. This trims to 2
// decimals (keeping more only when the amount genuinely has them).
// Human amount with NO trailing-zero noise: 5 USDC reads "5", not "5.00" or
// "5.000000". Padding a whole number out to decimals it doesn't have made a
// simple payment look like a machine dump; a payer reads "5" the way they'd
// read a price tag. Fractions keep exactly the digits they need ("5.25",
// "0.000001").
export function usdcDisplay(minor: bigint): string {
  const [whole, frac = ""] = usdcMinorToHuman(minor).split(".");
  const trimmed = frac.replace(/0+$/, "");
  return trimmed.length === 0 ? whole : `${whole}.${trimmed}`;
}

// Human-readable chain names. The SDK's identifiers ("Polygon_Amoy_Testnet")
// are correct but unreadable in a sentence a payer is meant to act on.
const CHAIN_LABELS: Record<string, string> = {
  [SOURCE_CHAINS.solana]: "Solana",
  [SOURCE_CHAINS.base]: "Base",
  [SOURCE_CHAINS.polygon]: "Polygon",
  [SOURCE_CHAINS.ethereum]: "Ethereum",
  [SOURCE_CHAINS.avalanche]: "Avalanche",
  [SOURCE_CHAINS.optimism]: "Optimism",
  [SOURCE_CHAINS.arbitrum]: "Arbitrum",
  [SOURCE_CHAINS.unichain]: "Unichain",
  [SOURCE_CHAINS.sonic]: "Sonic",
  [SOURCE_CHAINS.worldchain]: "World Chain",
  [SOURCE_CHAINS.sei]: "Sei",
  [SOURCE_CHAINS.hyperevm]: "HyperEVM",
  Arc_Testnet: "Arc",
};

export function chainLabel(chain: string): string {
  return (
    CHAIN_LABELS[chain] ??
    chain.replace(/_(Sepolia|Devnet|Testnet|Fuji|Amoy(_Testnet)?)$/i, "").replace(/_/g, " ")
  );
}

// The payer's funded chains only, richest first. Zero-balance chains are noise:
// listing every supported chain (mostly "0.000000 on …") buried the one or two
// that actually matter.
export function fundedChains(unified: UnifiedUsdc): Array<{ chain: string; minor: bigint }> {
  return unified.byChain
    .map((c) => ({ chain: c.chain, minor: usdcHumanToMinor(c.confirmed) }))
    .filter((c) => c.minor > 0n && chainToSourceSlug(c.chain) !== null)
    .sort((a, b) => (b.minor > a.minor ? 1 : -1));
}

export function usdcMinorToHuman(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const s = abs.toString().padStart(USDC_DECIMALS + 1, "0");
  const whole = s.slice(0, -USDC_DECIMALS);
  const frac = s.slice(-USDC_DECIMALS);
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

export function usdcHumanToMinor(human: string): bigint {
  const [whole, frac = ""] = human.split(".");
  const paddedFrac = (frac + "0".repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  return BigInt(`${whole}${paddedFrac}`);
}

// Build a UBK adapter over the payer's connected EVM wallet. `provider` is the
// EIP-1193 provider from wagmi's connector.getProvider() — the SAME provider
// the rest of the app signs Arc transactions through, so a Google
// embedded wallet and an injected MetaMask both flow through here identically.
export async function buildEvmAdapter(provider: unknown, address: string): Promise<PayerAdapter> {
  const { createViemAdapterFromProvider } = await import("@circle-fin/adapter-viem-v2");
  const adapter = await createViemAdapterFromProvider({
    provider: provider as never,
  });
  return { adapter, address, family: "evm", provider };
}

// Put the wallet on `chain` before we try to deposit from it.
//
// Circle's viem adapter builds the Gateway deposit against whatever network the
// wallet is CURRENTLY on, so paying with USDC held on Polygon while the wallet
// sits on Arc (which is where a payer on the checkout normally is) failed with
// "chainId should be same as current chainId" — the payer had the funds, on the
// chain they picked, and still couldn't pay. Nothing in the flow switched
// networks, so this does.
export async function ensureEvmChain(provider: unknown, chain: string): Promise<void> {
  const p = provider as {
    request?: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  };
  if (!p?.request) return;

  const { resolveChainIdentifier } = await import("@circle-fin/unified-balance-kit");
  const def = resolveChainIdentifier(chain as never) as unknown as {
    type?: string;
    chainId?: number;
    name?: string;
    rpcEndpoints?: readonly string[];
    explorerUrl?: string;
    nativeCurrency?: { name?: string; symbol?: string; decimals?: number };
  };
  if (def?.type !== "evm" || typeof def.chainId !== "number") return;

  const wanted = `0x${def.chainId.toString(16)}`;
  const current = (await p.request({ method: "eth_chainId" }).catch(() => null)) as string | null;
  if (current && current.toLowerCase() === wanted.toLowerCase()) return;

  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: wanted }] });
  } catch (err) {
    // 4902 = the wallet doesn't know this network yet. Add it, then it's
    // switched to as part of the add on every wallet that implements this.
    const code = (err as { code?: number })?.code;
    if (code !== 4902) throw err;
    await p.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: wanted,
          chainName: def.name ?? chain,
          rpcUrls: [...(def.rpcEndpoints ?? []), ...(BACKUP_RPCS[chain] ?? [])],
          nativeCurrency: {
            name: def.nativeCurrency?.name ?? "Ether",
            symbol: def.nativeCurrency?.symbol ?? "ETH",
            decimals: def.nativeCurrency?.decimals ?? 18,
          },
          blockExplorerUrls: def.explorerUrl ? [def.explorerUrl.replace(/\/tx\/.*$/, "")] : undefined,
        },
      ],
    });
  }
}

// Build a UBK adapter over Phantom (window.solana). This is what finally makes
// a Solana holder's USDC visible/spendable — no ETH wallet is ever generated
// or shown for this path.
export async function buildSolanaAdapter(provider: unknown, address: string): Promise<PayerAdapter> {
  const { createSolanaAdapterFromProvider } = await import("@circle-fin/adapter-solana");
  const { resolveChainIdentifier } = await import("@circle-fin/unified-balance-kit");

  // Pin the adapter to Solana DEVNET. With no explicit supportedChains the
  // adapter defaults to Solana MAINNET and builds mainnet deposit transactions
  // (mainnet RPC blockhash + mainnet Gateway program) -- which Solflare, set to
  // devnet, rejects as a "network mismatch". Handing it the resolved
  // Solana_Devnet ChainDefinition gives it the devnet RPC + devnet Gateway
  // program so the deposit is a genuine devnet transaction.
  const solanaDevnet = resolveChainIdentifier(SOURCE_CHAINS.solana);
  const adapter = await createSolanaAdapterFromProvider({
    provider: provider as never,
    capabilities: {
      addressContext: "user-controlled",
      supportedChains: [solanaDevnet],
    },
  } as never);
  return { adapter, address, family: "solana" };
}

// Read the payer's unified USDC balance across every chain their wallet's
// family can source from. One SDK call; the "unified" part is real.
export async function getUnifiedUsdc(payer: PayerAdapter): Promise<UnifiedUsdc> {
  const { getBalances } = await import("@circle-fin/unified-balance-kit");
  const ctx = await context();
  // GetBalancesResult shape (verified against index.d.cts): the per-account
  // array is `breakdown`, and each account has its OWN nested `breakdown` of
  // { chain, confirmedBalance }. The prior code read `res.balances`, which
  // doesn't exist — byChain came back empty and every bridge quote read as
  // "insufficient". token + networkType are both required.
  const res = (await getBalances(ctx as never, {
    token: TOKEN,
    networkType: NETWORK,
    sources: { adapter: payer.adapter as never },
  } as never)) as {
    totalConfirmedBalance?: string;
    breakdown?: Array<{ breakdown?: Array<{ chain: string; confirmedBalance: string }> }>;
  };

  const byChain: ChainUsdc[] = [];
  for (const account of res.breakdown ?? []) {
    for (const b of account.breakdown ?? []) {
      // Labelled as Gateway balance, which is exactly what this endpoint
      // reports. Downstream that means "spendable with a signature alone".
      byChain.push({
        chain: b.chain,
        confirmed: b.confirmedBalance,
        gateway: b.confirmedBalance,
        wallet: "0",
      });
    }
  }
  return { totalConfirmed: res.totalConfirmedBalance ?? "0", byChain };
}

// Circle's USDC mint on Solana Devnet -- what faucet.circle.com dispenses.
const SOLANA_DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

// The payer's raw WALLET USDC -- the balance getUnifiedUsdc can't see, because
// it reports only what's already been deposited into Circle Gateway. Since
// spendUsdcToArc() deposits from the wallet on demand, this wallet balance is
// genuinely spendable; without counting it, a payer who just holds USDC in
// Phantom (nothing deposited yet) is wrongly told "insufficient" before the
// deposit step ever runs -- the exact "found 0.000" bug. Covers BOTH families:
// Solana below, every EVM source chain via getEvmWalletUsdc.
/**
 * Lamports the payer holds, for the gas a Solana deposit actually costs.
 *
 * A Gateway deposit from Solana is a Solana transaction and pays a fee in SOL.
 * A wallet funded from Circle's USDC faucet routinely has plenty of USDC and
 * zero SOL, so the deposit cannot be submitted -- and the way that surfaces is
 * Circle's SDK retrying until it reports "Maximum retry attempts exceeded",
 * which we then translate to "the bridge isn't responding". The payer is told
 * to wait for a service that is fine, about a problem one faucet visit fixes.
 *
 * Returns null when the balance cannot be read: unknown is not the same as
 * empty, and blocking a payment on a failed RPC read would be worse than
 * letting the deposit try.
 */
export async function getSolanaLamports(address: string): Promise<bigint | null> {
  try {
    const { Connection, PublicKey } = await import("@solana/web3.js");
    const conn = new Connection("https://api.devnet.solana.com", "confirmed");
    return BigInt(await conn.getBalance(new PublicKey(address)));
  } catch {
    return null;
  }
}

/** Enough SOL to submit a deposit and its burn intent, with headroom. */
export const MIN_SOLANA_LAMPORTS = 2_000_000n; // 0.002 SOL

export async function getWalletUsdc(payer: PayerAdapter): Promise<ChainUsdc[]> {
  if (payer.family === "evm") return getEvmWalletUsdc(payer.address);
  try {
    const { Connection, PublicKey } = await import("@solana/web3.js");
    const conn = new Connection("https://api.devnet.solana.com", "confirmed");
    const accounts = await conn.getParsedTokenAccountsByOwner(new PublicKey(payer.address), {
      mint: new PublicKey(SOLANA_DEVNET_USDC_MINT),
    });
    let minor = 0n;
    for (const acc of accounts.value) {
      const amt = (
        acc.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }
      ).parsed?.info?.tokenAmount?.amount;
      if (amt) minor += BigInt(amt);
    }
    return minor > 0n
      ? [
          {
            chain: SOURCE_CHAINS.solana,
            confirmed: usdcMinorToHuman(minor),
            gateway: "0",
            wallet: usdcMinorToHuman(minor),
          },
        ]
      : [];
  } catch {
    // A wallet-balance read failure must not block: fall back to whatever
    // getUnifiedUsdc found. Worst case the payer sees the old behaviour.
    return [];
  }
}

// The EVM half of getWalletUsdc. An EVM payer holding USDC on Base (or any
// other supported source chain) but who has never deposited into Circle Gateway
// was shown "0.00 USDC" and could not pay at all -- getUnifiedUsdc reports only
// DEPOSITED balance, and this function used to bail out for every non-Solana
// wallet ("EVM source chains are a follow-up"). Since spendUsdcToArc deposits on
// demand, that wallet balance is genuinely spendable, so it has to be counted.
//
// The USDC address and RPC for each chain come from the SDK's own chain
// definitions (resolveChainIdentifier -> { usdcAddress, rpcEndpoints }), never a
// hardcoded table -- a wrong hardcoded token address would silently report the
// wrong balance, which is worse than reporting none.
// Extra RPC endpoints, appended AFTER the SDK's own. The SDK ships exactly one
// endpoint per chain, so without these a single unreachable or CORS-refusing
// host means that chain reads as empty and the payer is told they have no USDC
// on a chain they're actually funded on (measured: the SDK's Polygon Amoy
// endpoint already fails). Only RPC URLs are listed here, never token
// addresses -- a bad RPC fails closed and falls through, whereas a bad token
// address would confidently report a wrong balance.
const BACKUP_RPCS: Record<string, string[]> = {
  [SOURCE_CHAINS.base]: ["https://base-sepolia-rpc.publicnode.com"],
  [SOURCE_CHAINS.polygon]: ["https://polygon-amoy-bor-rpc.publicnode.com"],
  [SOURCE_CHAINS.ethereum]: ["https://rpc.sepolia.org"],
  [SOURCE_CHAINS.avalanche]: ["https://avalanche-fuji-c-chain-rpc.publicnode.com"],
  [SOURCE_CHAINS.optimism]: ["https://optimism-sepolia-rpc.publicnode.com"],
  [SOURCE_CHAINS.arbitrum]: ["https://arbitrum-sepolia-rpc.publicnode.com"],
  [SOURCE_CHAINS.unichain]: ["https://unichain-sepolia-rpc.publicnode.com"],
};

async function getEvmWalletUsdc(address: string): Promise<ChainUsdc[]> {
  const { resolveChainIdentifier } = await import("@circle-fin/unified-balance-kit");

  const evmChains = Object.entries(SOURCE_CHAINS).filter(([slug]) => slug !== "solana");
  const results = await Promise.all(
    evmChains.map(async ([, chainId]): Promise<ChainUsdc | null> => {
      try {
        const def = resolveChainIdentifier(chainId) as unknown as {
          type?: string;
          usdcAddress?: string | null;
          rpcEndpoints?: readonly string[];
        };
        if (def?.type !== "evm" || !def.usdcAddress) return null;
        const endpoints = [...(def.rpcEndpoints ?? []), ...(BACKUP_RPCS[chainId] ?? [])];
        if (!endpoints.length) return null;
        const minor = await erc20BalanceOfAnyRpc(endpoints, def.usdcAddress, address);
        return minor > 0n
          ? {
              chain: chainId,
              confirmed: usdcMinorToHuman(minor),
              gateway: "0",
              wallet: usdcMinorToHuman(minor),
            }
          : null;
      } catch {
        // One unreachable/rate-limited public RPC must not zero out the payer's
        // whole balance view -- skip that chain and keep the others.
        return null;
      }
    })
  );
  return results.filter((r): r is ChainUsdc => r !== null);
}

// Try each of a chain's RPC endpoints until one answers. These are public
// endpoints called straight from the browser, so the first one can fail for
// reasons that have nothing to do with the payer -- rate limiting, or no CORS
// headers at all. Falling back through the list means one unfriendly primary
// endpoint doesn't report a funded chain as empty.
async function erc20BalanceOfAnyRpc(
  rpcUrls: readonly string[],
  token: string,
  owner: string
): Promise<bigint> {
  for (const url of rpcUrls) {
    try {
      return await erc20BalanceOf(url, token, owner);
    } catch {
      // try the next endpoint
    }
  }
  return 0n;
}

// Minimal ERC-20 balanceOf via raw JSON-RPC. Deliberately not viem/ethers: this
// runs against a dozen public testnet RPCs whose chain configs we don't control,
// and a plain eth_call needs no per-chain client setup.
async function erc20BalanceOf(rpcUrl: string, token: string, owner: string): Promise<bigint> {
  // balanceOf(address) selector + 32-byte left-padded owner address.
  const data = "0x70a08231" + owner.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  // A hanging RPC must not stall the balance screen behind it.
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 6000);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: token, data }, "latest"],
      }),
      signal: abort.signal,
    });
    // Throw rather than return 0 on a transport/RPC failure: a failed call and
    // a genuine zero balance are completely different answers, and only the
    // former should fall through to the next endpoint.
    if (!res.ok) throw new Error(`rpc ${res.status}`);
    const json = (await res.json()) as { result?: string; error?: { message?: string } };
    if (json.error) throw new Error(json.error.message ?? "rpc error");
    if (!json.result || json.result === "0x") return 0n;
    return BigInt(json.result);
  } finally {
    clearTimeout(timeout);
  }
}

// Combine already-deposited Gateway balance with spendable wallet balance into
// one per-chain view, so the funding check sizes against everything the payer
// can actually pay with. spendUsdcToArc() then deposits any wallet portion at
// spend time (its deposit-if-needed loop covers the shortfall between the two).
export function mergeUsdc(deposited: UnifiedUsdc, wallet: ChainUsdc[]): UnifiedUsdc {
  const minorByChain = new Map<string, bigint>();
  // `deposited` may legitimately be an empty object.
  //
  // Its callers hand one over when the Gateway read fails, on purpose: Circle's
  // testnet API flaps, and the wallet balance is readable without it. But the
  // spread below did not survive that -- `[...undefined]` throws, so the
  // tolerant path took the screen down exactly when it was supposed to be
  // rescuing it, and only when Circle was already having a bad day.
  // The split is carried through, not flattened. Both halves are spendable, but
  // only the Gateway half is spendable for free -- and spendUsdcToArc has to
  // know which is which to work out how many deposits a payment needs. Summing
  // them into one number here is what made "one chain must cover it" look like
  // the only possible rule.
  const gatewayByChain = new Map<string, bigint>();
  const walletByChain = new Map<string, bigint>();
  for (const c of [...(deposited?.byChain ?? []), ...wallet]) {
    const { gateway, wallet: w, total } = splitOf(c);
    minorByChain.set(c.chain, (minorByChain.get(c.chain) ?? 0n) + total);
    gatewayByChain.set(c.chain, (gatewayByChain.get(c.chain) ?? 0n) + gateway);
    walletByChain.set(c.chain, (walletByChain.get(c.chain) ?? 0n) + w);
  }
  const byChain = [...minorByChain].map(([chain, minor]) => ({
    chain,
    confirmed: usdcMinorToHuman(minor),
    gateway: usdcMinorToHuman(gatewayByChain.get(chain) ?? 0n),
    wallet: usdcMinorToHuman(walletByChain.get(chain) ?? 0n),
  }));
  const total = byChain.reduce((s, c) => s + usdcHumanToMinor(c.confirmed), 0n);
  return { totalConfirmed: usdcMinorToHuman(total), byChain };
}

// Map a UBK chain identifier back to the short source-chain slug the API's
// report_spend endpoint expects.
export function chainToSourceSlug(chain: string): SourceKind | null {
  for (const [slug, id] of Object.entries(SOURCE_CHAINS)) {
    if (id === chain) return slug as SourceKind;
  }
  return null;
}

// planAllocations -- a greedy plan spreading one payment across several source
// chains -- was removed.
//
// Nothing could execute it. spendUsdcToArc deposits the full amount on a single
// chain and spends it there, so a multi-chain plan was only ever a claim the
// spend could not honour: it let the confirm screen accept a payment that then
// failed in the deposit wait with a message about timing.
//
// It is a feature, not a bug fix, and a costly one -- a deposit transaction per
// source chain, each needing that chain's own native gas. Worth building
// deliberately if it is ever wanted, rather than left half-present.


/**
 * Thrown once the deposit has left the payer's wallet.
 *
 * The distinction is the whole point: before the deposit, a failure means
 * nothing happened and "try again" is free. After it, the money is in Circle
 * Gateway, and telling the payer nothing left their wallet is both false and
 * the exact sentence that makes them retry as though it were free.
 */
export class FundsInGatewayError extends Error {
  readonly fundsInGateway = true;
  constructor(message: string) {
    super(message);
    this.name = "FundsInGatewayError";
  }
}

export interface SpendToArcResult {
  txHash: string;
  /** Gateway transfer id — handed to the API so it can poll + settle. */
  transferId?: string;
  explorerUrl?: string;
  /**
   * The chains the spend actually drew from, in the order it drew from them.
   *
   * Plural because a payment can now be funded from several at once. The first
   * is the largest contributor and is what gets reported to the API as the
   * source chain; the full list is what the receipt shows the payer.
   */
  chains: string[];
}

// Deposit-if-needed then spend `amountMinor` USDC, minting it on Arc to
// `recipientAddress` (Conduit's relayer). The forwarder makes Circle's own
// relayer submit the Arc-side mint; we never sign anything on Arc here.
//
// `allocations` says which source chain(s) to pull from. For a single-family
// wallet the caller passes the chain(s) where the payer holds balance.
export async function spendUsdcToArc(params: {
  payer: PayerAdapter;
  amountMinor: bigint;
  recipientAddress: string;
  /**
   * The chains available to fund this payment, in the order to draw from them,
   * each with the payer's FULL spendable balance there.
   *
   * Available balance, not a per-chain share of the amount. That distinction
   * matters: Circle charges its own fee on top of the spend, so this has to
   * deposit `need` PLUS a buffer (see `target` below), and a list of shares
   * summing to exactly `need` can never reach that target -- a payer holding 20
   * on Polygon and 20 on Base, paying 30, would deposit exactly 30 against a
   * target of 33.60 and then wait out the confirm loop for a shortfall no
   * amount of waiting could fix. Handed the real balances, the loop takes 20
   * from Polygon and 13.60 from Base and stops.
   *
   * Order is the caller's routing preference (richest first, or the payer's
   * chosen chain first). Chains beyond what the amount needs are harmless: the
   * loop stops as soon as Gateway holds enough, so trailing entries are only
   * reached when the fee buffer needs them.
   *
   * More than one entry is normal for an EVM payer now. Gateway pools a payer's
   * deposited balance ACROSS chains and settles the whole set with a single
   * EIP-712 signature (the SDK batches every intent for one adapter into one
   * `BurnIntentSet` -- see the note above the spend call), so a payment no
   * longer has to fit inside one chain. Solana always passes exactly one: it
   * signs with a different adapter and cannot join an EVM set.
   */
  sources: Array<{ chain: string; availableMinor: bigint }>;
  /**
   * Progress, because this function is not quick and it takes the payer's money
   * on the way through.
   *
   * It signs, debits, then waits up to two minutes for Circle to confirm the
   * deposit, then asks for a SECOND signature. With no reporting the caller was
   * left showing "Confirm in your wallet" throughout -- so a payer whose wallet
   * had already been debited sat looking at a prompt they had answered, with no
   * way to tell a slow confirmation from a hang.
   */
  onProgress?: (note: string) => void;
}): Promise<SpendToArcResult> {
  const say = params.onProgress ?? (() => {});
  const { spend, deposit } = await import("@circle-fin/unified-balance-kit");
  const ctx = await context();

  const need = params.amountMinor;
  if (params.sources.length === 0) throw new Error("No chain was chosen to pay from.");

  // Read BOTH confirmed (spendable) and pending (in-flight deposit) Gateway
  // balance, per chain as well as in total. Counting pending is what stops the
  // wallet-draining: without it, a deposit that's still confirming is invisible,
  // so every retry deposited AGAIN on top of the last one. `confirmed + pending`
  // is what's actually committed; only deposit if even that can't cover it.
  //
  // Per chain matters now that a payment can draw from several: the spend
  // allocations below have to name real, confirmed balances on real chains.
  const gatewayBalance = async () => {
    const { getBalances } = await import("@circle-fin/unified-balance-kit");
    const res = (await getBalances(ctx as never, {
      token: TOKEN,
      networkType: NETWORK,
      sources: { adapter: params.payer.adapter as never },
      includePending: true,
    } as never)) as {
      totalConfirmedBalance?: string;
      totalPendingBalance?: string;
      breakdown?: Array<{
        breakdown?: Array<{ chain: string; confirmedBalance?: string; pendingBalance?: string }>;
      }>;
    };
    const byChain = new Map<string, { confirmed: bigint; pending: bigint }>();
    for (const account of res.breakdown ?? []) {
      for (const b of account.breakdown ?? []) {
        const prev = byChain.get(b.chain) ?? { confirmed: 0n, pending: 0n };
        byChain.set(b.chain, {
          confirmed: prev.confirmed + usdcHumanToMinor(b.confirmedBalance ?? "0"),
          pending: prev.pending + usdcHumanToMinor(b.pendingBalance ?? "0"),
        });
      }
    }
    return {
      confirmed: usdcHumanToMinor(res.totalConfirmedBalance ?? "0"),
      pending: usdcHumanToMinor(res.totalPendingBalance ?? "0"),
      byChain,
    };
  };

  // Circle charges its OWN fees on top of the spend amount, and spend() checks
  // the balance against amount + those fees. Measured live on devnet: a 3.00
  // spend demanded 3.163727, 3.50 demanded 3.60, 5.00 demanded 5.16393 -- about
  // 3-6% over. Depositing exactly `need` therefore ALWAYS fell short by the fee
  // ("Available: 3.5, required: 3.6"), no matter how long we waited, because
  // the shortfall was never a timing problem. Fund a 12% buffer (floor 0.30
  // USDC for small amounts) so the fee is always covered. Unspent buffer stays
  // in the payer's Gateway balance and is used by their next payment -- it is
  // not a fee we charge and it is not lost.
  const buffer = (need * 12n) / 100n;
  const target = need + (buffer > 300_000n ? buffer : 300_000n);

  let bal = await gatewayBalance();

  // Whether the payer's money has moved. Everything after this point must tell
  // the truth about that, however the failure arrives.
  let deposited = bal.confirmed + bal.pending > 0n;

  // Top up Gateway, chain by chain.
  //
  // This is the half of the "unified balance" that cannot be unified. Reading
  // and spending pool across chains for free, but USDC sitting in the wallet
  // has to physically enter Gateway, and a deposit is an on-chain transaction
  // on the chain the money is on -- approve, deposit, that chain's gas, and for
  // an EVM wallet a network switch to get there first. So a payment funded from
  // two chains costs two deposits and then ONE signature, not two signatures.
  //
  // Chains are visited in the order the caller planned them (richest first), and
  // the loop stops the moment Gateway holds enough: an allocation is a budget,
  // not an instruction to move that exact amount.
  if (bal.confirmed + bal.pending < target) {
    for (const source of params.sources) {
      const committed = bal.confirmed + bal.pending;
      if (committed >= target) break;

      const here = bal.byChain.get(source.chain) ?? { confirmed: 0n, pending: 0n };
      // What this chain can still contribute: its whole balance less whatever
      // of it is already inside Gateway, capped by what is still missing
      // overall so the last chain is not over-deposited.
      const stillNeeded = target - committed;
      const roomHere = source.availableMinor - (here.confirmed + here.pending);
      const amount = roomHere < stillNeeded ? roomHere : stillNeeded;
      if (amount <= 0n) continue;

      // Depositing from an EVM chain requires the wallet to BE on that chain --
      // viem rejects it otherwise ("chainId should be same as current chainId").
      // With one source chain the caller switched once before calling this; with
      // several, the switch has to happen per deposit, which is why it lives
      // here now rather than at the call site.
      let payer = params.payer;
      if (payer.family === "evm" && payer.provider) {
        say(`Switch to ${chainLabel(source.chain)} in your wallet…`);
        await ensureEvmChain(payer.provider, source.chain);
        payer = await buildEvmAdapter(payer.provider, payer.address);
      }

      say(
        params.sources.length > 1
          ? `Approve the deposit from ${chainLabel(source.chain)} in your wallet…`
          : "Approve the deposit in your wallet…",
      );
      await deposit(ctx as never, {
        from: { adapter: payer.adapter as never, chain: source.chain as never },
        amount: usdcMinorToHuman(amount),
        token: TOKEN,
      } as never);
      deposited = true;

      // Re-read rather than assume the deposit landed as `amount`: the next
      // chain's budget depends on what Gateway actually credited.
      try {
        bal = await gatewayBalance();
      } catch {
        // A read failure between deposits must not strand the payer -- the
        // confirm wait below re-reads anyway, and it knows how to report money
        // that has already moved.
        break;
      }
    }
  }

  // A Gateway deposit isn't spendable until it CONFIRMS. Wait for the confirmed
  // balance to cover the target before spending — spend() draws confirmed
  // balance only, and running it early left the fresh USDC stuck in Gateway.
  const deadline = Date.now() + 120_000;
  const started = Date.now();
  while (bal.confirmed < target && Date.now() < deadline) {
    const secs = Math.round((Date.now() - started) / 1000);
    // Named as a wait on Circle, with the elapsed time, so it reads as
    // progress rather than as a frozen screen. This is the step that used to
    // look like a hang.
    say(`Deposit sent. Waiting for Circle to confirm… ${secs}s`);
    await new Promise((r) => setTimeout(r, 5000));
    try {
      bal = await gatewayBalance();
    } catch (e) {
      // A failed balance READ after a successful deposit is the case that was
      // being reported as "the bridge isn't responding, nothing has left your
      // wallet". The first half was right; the second was a lie about the
      // payer's money.
      if (deposited) {
        throw new FundsInGatewayError(
          "Your USDC is in Circle Gateway and Circle stopped answering while we waited for it to confirm. " +
            "It is safe and will not be deposited again. Press Pay to finish."
        );
      }
      throw e;
    }
  }
  if (bal.confirmed < target) {
    // Two different failures wear the same shape here, and only one is about
    // timing. If every source is drained and Gateway still holds less than the
    // target, no amount of waiting will help: the payer is short of Circle's
    // fee, not early. Telling them to wait 30s for that is a message that can
    // never come true, and they would keep pressing Pay against it.
    const available = params.sources.reduce((sum, s) => sum + s.availableMinor, 0n);
    if (available < target) {
      throw new FundsInGatewayError(
        `Circle charges a fee on top of the amount, so this needs about ` +
          `${usdcDisplay(target)} USDC and you have ${usdcDisplay(available)}. ` +
          `Top up any of your chains by ${usdcDisplay(target - available)} and try again. ` +
          `Anything already deposited is safe and will be used by this payment.`
      );
    }
    throw new FundsInGatewayError(
      "Your USDC is deposited in Circle Gateway and still confirming — it's safe and won't deposit again. Wait ~30s and press Pay to finish."
    );
  }

  // The allocations the spend actually executes, derived from CONFIRMED Gateway
  // balance rather than from the caller's plan.
  //
  // The plan was drawn against wallet balances before anything moved; by now the
  // money is in Gateway, and what matters is where Circle says it is. Deriving
  // from the confirmed balances also keeps the one invariant the SDK enforces --
  // "Sum of allocations does not match amount" -- true by construction, since
  // this fills to exactly `need` and stops.
  const preferred = params.sources.map((a) => a.chain);
  const order = [
    ...preferred,
    ...[...bal.byChain.keys()].filter((c) => !preferred.includes(c)),
  ];
  const spendAllocations: Array<{ chain: string; amount: string }> = [];
  let remaining = need;
  for (const chain of order) {
    if (remaining <= 0n) break;
    const available = bal.byChain.get(chain)?.confirmed ?? 0n;
    if (available <= 0n) continue;
    const take = available < remaining ? available : remaining;
    spendAllocations.push({ chain, amount: usdcMinorToHuman(take) });
    remaining -= take;
  }
  if (remaining > 0n) {
    // Total covers the amount but the per-chain breakdown does not add up --
    // which means the breakdown is stale, not that the payer is short.
    throw new FundsInGatewayError(
      "Your USDC is in Circle Gateway but Circle's per-chain balances are still catching up. " +
        "Wait a moment and press Pay to finish — nothing will be deposited again."
    );
  }

  // SpendParams (verified): the amount key is `amountIn` (optional here since we
  // pass explicit per-chain allocations), `token` is required, and the
  // destination is a FORWARDER-ONLY destination — { chain, recipientAddress,
  // useForwarder:true }, NO adapter. The prior code passed the payer's own
  // (Base/Polygon/Solana) adapter as the Arc destination and omitted
  // useForwarder, so the SDK tried to sign the Arc mint with a wrong-family
  // wallet and never returned a transferId for the API to poll.
  // maxFee is NOT ours to set.
  //
  // A previous attempt here allocated above the spend amount, on the theory
  // that Circle derives each intent's maxFee from the gap. It does not, and the
  // SDK rejects the idea outright: "Sum of allocations does not match amount".
  // The SDK builds the intents, submits them to Circle's estimate API, and
  // replaces maxFee with the values that API returns (see parseEstimateResponse
  // in the shipped bundle). There is no maxFee field on SpendParams because
  // there is nothing for a caller to decide.
  //
  // So "Insufficient total maxFee across intents to cover forwarding fee" is
  // Circle's estimate coming back short of Circle's own forwarding fee. It is
  // not something to work around from here, and inventing a workaround broke a
  // working call.
  //
  // ONE signature, however many chains are listed. From the SDK's own
  // adapter-evm source: "all intents for the same adapter are batched into a
  // single group so that they can be signed in one EIP-712 BurnIntentSet
  // operation", producing "a single EIP-712 ECDSA signature". A single-chain
  // spend signs primaryType 'BurnIntent'; a multi-chain one signs
  // 'BurnIntentSet'. Either way the payer is asked once.
  const spendParams = {
    token: TOKEN,
    // Top-level total is REQUIRED by SpendParams (see estimateSpend's own
    // example: from.allocations + a top-level `amount`). Omitting it made the
    // SDK validate a placeholder "unknown" and throw "Invalid amount
    // 'unknown'" — the per-chain allocation amounts alone weren't enough.
    amount: usdcMinorToHuman(need),
    from: {
      adapter: params.payer.adapter as never,
      allocations: spendAllocations as never,
    },
    to: {
      chain: ARC_CHAIN as never,
      recipientAddress: params.recipientAddress,
      useForwarder: true,
    },
  };

  // Call spend ONCE. It was retried in a loop here, but every attempt re-runs
  // the burn-intent signature, so a persistent failure became an endless
  // "sign → load → sign again" loop in the payer's wallet. The failure it was
  // retrying (insufficient balance) was never transient anyway: it was the
  // unfunded fee, fixed above by depositing to `target`.
  say("Approve the payment in your wallet…");
  let result: { txHash: string; transferId?: string; explorerUrl?: string };
  // Watch the SDK's own HTTP attempts for the duration of this spend. The SDK
  // retries the /v1/transfer POST with byte-identical signed bytes when Circle
  // answers slower than its 2s default timeout, which is what produces the
  // "Transfer spec has already been used" 400 on a transfer Circle already
  // accepted. We cannot reach that retry policy to turn it off, so we record it.
  const { traceGatewayCalls, gatewayTrace, noteSpendCall, resetGatewayTrace } = await import(
    "@/lib/gateway-trace"
  );
  resetGatewayTrace();
  const untrace = traceGatewayCalls();
  try {
    noteSpendCall();
    result = (await spend(ctx as never, spendParams as never)) as {
      txHash: string;
      transferId?: string;
      explorerUrl?: string;
    };
  } catch (e) {
    // Verbatim, BEFORE any classification. Every decision below this line is a
    // statement about whether the payer's money has moved, and each one has been
    // wrong at least once because it was made by matching prose. The raw error,
    // its cause, its status and the HTTP attempts behind it are what settle that.
    const trace = gatewayTrace();
    console.error("gateway spend failed", {
      raw: e instanceof Error ? e.message : String(e),
      name: (e as Error)?.name,
      stack: (e as Error)?.stack,
      cause: (e as { cause?: unknown })?.cause,
      status: (e as { status?: number })?.status,
      response: (e as { response?: unknown })?.response,
      spendCalls: trace.spendCalls,
      transferPosts: trace.posts.length,
      // Identical hashes across attempts is a literal replay of one signed spec.
      bodyHashes: trace.posts.map((p) => p.bodySha256),
      salts: trace.posts.map((p) => p.salts),
      statuses: trace.posts.map((p) => p.status ?? p.error),
      trace: trace.posts,
    });
    // Same truth at the last step. The deposit is done by now, so a failed
    // burn intent leaves funded Gateway balance, not an untouched wallet.
    const raw = e instanceof Error ? e.message : "The payment could not be authorised.";
    // A replay, not a failure to authorise. Circle refuses a transfer spec it
    // has already accepted, which means the FIRST attempt was committed --
    // telling the payer to press Pay again would loop them on the same refusal.
    if (/transfer spec has already been used/i.test(raw)) {
      throw new FundsInGatewayError(
        "This transfer was already submitted to Circle and cannot be sent twice. " +
          "Your USDC is safe in Circle Gateway. Start a new payment to spend it, " +
          "or check History -- the first attempt may still be settling."
      );
    }
    throw new FundsInGatewayError(
      raw + " Your USDC is in Circle Gateway and will not be deposited again — press Pay to retry."
    );
  } finally {
    // Never leave window.fetch patched, on any path.
    untrace();
  }

  return {
    txHash: result.txHash,
    transferId: result.transferId,
    explorerUrl: result.explorerUrl,
    chains: spendAllocations.map((a) => a.chain),
  };
}
