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
  /** Confirmed, already-in-Gateway USDC as a human string, e.g. "11.130000". */
  confirmed: string;
}

export interface UnifiedUsdc {
  /** Total confirmed Gateway balance across all chains, human string. */
  totalConfirmed: string;
  byChain: ChainUsdc[];
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
// the rest of the app signs Arc transactions through, so a Google/Privy
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
      byChain.push({ chain: b.chain, confirmed: b.confirmedBalance });
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
    return minor > 0n ? [{ chain: SOURCE_CHAINS.solana, confirmed: usdcMinorToHuman(minor) }] : [];
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
        return minor > 0n ? { chain: chainId, confirmed: usdcMinorToHuman(minor) } : null;
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
// one per-chain view, so planAllocations sizes against everything the payer can
// actually pay with. spendUsdcToArc() then deposits any wallet portion at spend
// time (its deposit-if-needed loop covers the shortfall between the two).
export function mergeUsdc(deposited: UnifiedUsdc, wallet: ChainUsdc[]): UnifiedUsdc {
  const minorByChain = new Map<string, bigint>();
  for (const c of [...deposited.byChain, ...wallet]) {
    minorByChain.set(c.chain, (minorByChain.get(c.chain) ?? 0n) + usdcHumanToMinor(c.confirmed));
  }
  const byChain = [...minorByChain].map(([chain, minor]) => ({
    chain,
    confirmed: usdcMinorToHuman(minor),
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

// Greedily pick source allocations from the payer's per-chain balances to cover
// `requiredMinor` USDC. Returns null if the unified balance can't cover it.
export function planAllocations(
  unified: UnifiedUsdc,
  requiredMinor: bigint
): { allocations: Array<{ chain: string; amountMinor: bigint }>; primary: SourceKind } | null {
  const sorted = [...unified.byChain]
    .map((c) => ({ chain: c.chain, minor: usdcHumanToMinor(c.confirmed) }))
    .filter((c) => c.minor > 0n && chainToSourceSlug(c.chain) !== null)
    .sort((a, b) => (b.minor > a.minor ? 1 : -1));

  const allocations: Array<{ chain: string; amountMinor: bigint }> = [];
  let remaining = requiredMinor;
  for (const c of sorted) {
    if (remaining <= 0n) break;
    const take = c.minor < remaining ? c.minor : remaining;
    allocations.push({ chain: c.chain, amountMinor: take });
    remaining -= take;
  }
  if (remaining > 0n || allocations.length === 0) return null;

  const primary = chainToSourceSlug(allocations[0].chain);
  if (!primary) return null;
  return { allocations, primary };
}

export interface SpendToArcResult {
  txHash: string;
  /** Gateway transfer id — handed to the API so it can poll + settle. */
  transferId?: string;
  explorerUrl?: string;
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
  allocations: Array<{ chain: string; amountMinor: bigint }>;
}): Promise<SpendToArcResult> {
  const { spend, deposit } = await import("@circle-fin/unified-balance-kit");
  const ctx = await context();

  const need = params.amountMinor;
  // The chain we deposit into and later spend from. Single-family (Solana)
  // wallet → the one chain the caller allocated.
  const primaryChain = params.allocations[0]?.chain ?? SOURCE_CHAINS.solana;

  // Read BOTH confirmed (spendable) and pending (in-flight deposit) Gateway
  // balance. Counting pending is what stops the wallet-draining: without it,
  // getUnifiedUsdc's confirmed total ignores a deposit that's still confirming,
  // so every retry deposited AGAIN on top of the last one. `confirmed + pending`
  // is what's actually committed; only deposit if even that can't cover it.
  const gatewayBalance = async () => {
    const { getBalances } = await import("@circle-fin/unified-balance-kit");
    const res = (await getBalances(ctx as never, {
      token: TOKEN,
      networkType: NETWORK,
      sources: { adapter: params.payer.adapter as never },
      includePending: true,
    } as never)) as { totalConfirmedBalance?: string; totalPendingBalance?: string };
    return {
      confirmed: usdcHumanToMinor(res.totalConfirmedBalance ?? "0"),
      pending: usdcHumanToMinor(res.totalPendingBalance ?? "0"),
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

  let { confirmed, pending } = await gatewayBalance();

  // Deposit only if nothing already in Gateway (confirmed OR mid-confirmation)
  // covers the target.
  if (confirmed + pending < target) {
    const shortfall = target - (confirmed + pending);
    await deposit(ctx as never, {
      from: { adapter: params.payer.adapter as never, chain: primaryChain as never },
      amount: usdcMinorToHuman(shortfall),
      token: TOKEN,
    } as never);
  }

  // A Gateway deposit isn't spendable until it CONFIRMS. Wait for the confirmed
  // balance to cover the target before spending — spend() draws confirmed
  // balance only, and running it early left the fresh USDC stuck in Gateway.
  const deadline = Date.now() + 120_000;
  while (confirmed < target && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    ({ confirmed, pending } = await gatewayBalance());
  }
  if (confirmed < target) {
    throw new Error(
      "Your USDC is deposited in Circle Gateway and still confirming — it's safe and won't deposit again. Wait ~30s and press Pay to finish."
    );
  }

  // SpendParams (verified): the amount key is `amountIn` (optional here since we
  // pass explicit per-chain allocations), `token` is required, and the
  // destination is a FORWARDER-ONLY destination — { chain, recipientAddress,
  // useForwarder:true }, NO adapter. The prior code passed the payer's own
  // (Base/Polygon/Solana) adapter as the Arc destination and omitted
  // useForwarder, so the SDK tried to sign the Arc mint with a wrong-family
  // wallet and never returned a transferId for the API to poll.
  const spendParams = {
    token: TOKEN,
    // Top-level total is REQUIRED by SpendParams (see estimateSpend's own
    // example: from.allocations + a top-level `amount`). Omitting it made the
    // SDK validate a placeholder "unknown" and throw "Invalid amount
    // 'unknown'" — the per-chain allocation amounts alone weren't enough.
    amount: usdcMinorToHuman(need),
    from: {
      adapter: params.payer.adapter as never,
      // Spend the full amount from the chain we just confirmed the deposit on,
      // rather than the pre-deposit wallet allocation.
      allocations: [{ chain: primaryChain as never, amount: usdcMinorToHuman(need) }],
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
  const result = (await spend(ctx as never, spendParams as never)) as {
    txHash: string;
    transferId?: string;
    explorerUrl?: string;
  };

  return { txHash: result.txHash, transferId: result.transferId, explorerUrl: result.explorerUrl };
}
