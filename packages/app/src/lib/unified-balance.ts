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
export const SOURCE_CHAINS = {
  base: "Base_Sepolia",
  polygon: "Polygon_Amoy_Testnet",
  solana: "Solana_Devnet",
} as const;

export type SourceKind = keyof typeof SOURCE_CHAINS;

// An opaque handle to a built UBK adapter (the SDK's adapter type is deeply
// generic; callers never need its shape, only to pass it back in).
export interface PayerAdapter {
  adapter: unknown;
  /** The payer's address on the wallet that built this adapter. */
  address: string;
  /** "evm" adapters can source from every EVM chain; "solana" only Solana. */
  family: "evm" | "solana";
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
  return { adapter, address, family: "evm" };
}

// Build a UBK adapter over Phantom (window.solana). This is what finally makes
// a Solana holder's USDC visible/spendable — no ETH wallet is ever generated
// or shown for this path.
export async function buildSolanaAdapter(provider: unknown, address: string): Promise<PayerAdapter> {
  const { createSolanaAdapterFromProvider } = await import("@circle-fin/adapter-solana");
  const adapter = await createSolanaAdapterFromProvider({
    provider: provider as never,
  });
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
// deposit step ever runs -- the exact "found 0.000" bug. Solana only for now
// (the tested cross-chain path); EVM source chains are a follow-up.
export async function getWalletUsdc(payer: PayerAdapter): Promise<ChainUsdc[]> {
  if (payer.family !== "solana") return [];
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

  // Ensure each source chain has enough *deposited* Gateway balance; deposit
  // the shortfall straight from the connected wallet if not. (spend() pulls
  // only from already-deposited balance — matching the Go PrepareFund logic
  // this replaces.)
  const unified = await getUnifiedUsdc(params.payer);
  for (const alloc of params.allocations) {
    const have = unified.byChain.find((c) => c.chain === alloc.chain)?.confirmed ?? "0";
    const haveMinor = usdcHumanToMinor(have);
    if (haveMinor < alloc.amountMinor) {
      const shortfall = alloc.amountMinor - haveMinor;
      // DepositParams requires `token`; `from` is an AdapterContext {adapter,chain}.
      await deposit(ctx as never, {
        from: { adapter: params.payer.adapter as never, chain: alloc.chain as never },
        amount: usdcMinorToHuman(shortfall),
        token: TOKEN,
      } as never);
    }
  }

  // SpendParams (verified): the amount key is `amountIn` (optional here since we
  // pass explicit per-chain allocations), `token` is required, and the
  // destination is a FORWARDER-ONLY destination — { chain, recipientAddress,
  // useForwarder:true }, NO adapter. The prior code passed the payer's own
  // (Base/Polygon/Solana) adapter as the Arc destination and omitted
  // useForwarder, so the SDK tried to sign the Arc mint with a wrong-family
  // wallet and never returned a transferId for the API to poll.
  const result = (await spend(ctx as never, {
    token: TOKEN,
    from: {
      adapter: params.payer.adapter as never,
      allocations: params.allocations.map((a) => ({
        chain: a.chain as never,
        amount: usdcMinorToHuman(a.amountMinor),
      })),
    },
    to: {
      chain: ARC_CHAIN as never,
      recipientAddress: params.recipientAddress,
      useForwarder: true,
    },
  } as never)) as { txHash: string; transferId?: string; explorerUrl?: string };

  return { txHash: result.txHash, transferId: result.transferId, explorerUrl: result.explorerUrl };
}
