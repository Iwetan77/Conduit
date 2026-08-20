"use client";

// Cross-chain funding via Circle's Unified Balance Kit, driven CLIENT-SIDE
// (option B — see the cross-chain discussion / lib/unified-balance.ts). The
// payer pays with their USDC from ANY supported source chain — Solana (Phantom)
// or an EVM chain like Base / Polygon (their connected EVM wallet) — and the
// SDK's adapters own the per-chain signing. No ETH wallet is generated for a
// Solana payer, and their Solana USDC is read + spent directly.
//
// The USDC is minted onto Arc at Conduit's relayer address; the server then
// runs its existing StableFX settlement (converting to the merchant's currency)
// exactly as before. This component never touches the merchant's settle
// currency — only USDC.
import { pollWithBackoff } from "@/lib/poll";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useConnect, useDisconnect, type Connector } from "wagmi";
import { usePayerIdentity } from "@/lib/use-payer-identity";
import { routeForAmount } from "@/lib/use-payer-usdc";
import { shortenAddress } from "@/lib/format";
import {
  getSolanaProvider,
  connectSolanaWallet,
  disconnectSolanaWallet,
  listSolanaWallets,
} from "@/lib/solana-wallet";
import {
  getBridgePlan,
  reportBridgeSpend,
  getPublicSettlementIntent,
  getBridgeStatus,
  ConduitApiError,
  type PublicSettlementIntent,
} from "@/lib/conduit-api";
import { isoToToken } from "@/lib/currencies";
import { formatAmount } from "@/lib/format";
import type { Currency } from "@conduit/sdk/lite";
import {
  buildEvmAdapter,
  buildSolanaAdapter,
  getUnifiedUsdc,
  getWalletUsdc,
  mergeUsdc,
  spendUsdcToArc,
  FundsInGatewayError,
  getSolanaLamports,
  MIN_SOLANA_LAMPORTS,
  usdcDisplay,
  chainLabel,
  chainToSourceSlug,
  fundedChains,
  SOURCE_CHAINS,
  SOURCE_CHAIN_LABELS,
  type SourceKind,
  type PayerAdapter,
  type UnifiedUsdc,
} from "@/lib/unified-balance";
import { ChainIcon } from "@/components/PayFlow/ChainIcon";
import { CIRCLE_CONNECTOR_ID } from "@/lib/circle/connector";
import { chainByEvmId } from "@/lib/circle/chains";
import { Rocket } from "@/components/Shared/Rocket";

interface CrossChainBridgeProps {
  intentId: string;
  intent: PublicSettlementIntent;
  /**
   * Balances the caller has already read, if it has.
   *
   * The page reads these when the wallet connects, so re-reading them after
   * Send meant a fan out across twelve chains that the payer waited on for a
   * second time, having already waited once -- and it is the same answer. Pass
   * them in and this skips straight to confirm. Omitted, it reads them itself,
   * which is still what happens when a payer arrives with nothing connected.
   */
  knownUsdc?: UnifiedUsdc | null;
  /**
   * Called as the bridge moves between coarse stages, so the surface around it
   * can stop describing a decision the payer has already made.
   *
   * "Paying from Solana" is the right thing to say while it is still a
   * statement about what is *about* to happen. It was rendered above this
   * component unconditionally, so it stayed on screen through the transfer and
   * sat above the word "Paid" on the receipt -- present tense over a finished
   * payment, and contradicting the receipt's own "Paid from" row.
   */
  onStage?: (stage: BridgeStage) => void;
}

/**
 * Where the payer is, coarsely: still being set up, committed and in flight, or
 * finished. Deliberately coarser than Phase — a caller that switched on the
 * full phase list would have to be revisited every time one is added.
 */
export type BridgeStage = "setup" | "paying" | "done";

type Phase =
  | "choose_source"
  | "connecting"
  | "checking_balance"
  | "insufficient"
  | "confirm"
  | "spending"
  | "bridging"
  | "settled"
  | "error";


// Circle's Gateway API exhausting its own retries, told plainly.
//
// The SDK surfaces "Gateway API error: Maximum retry attempts (10) exceeded:
// Request timed out", which reads like our bug and offers the payer nothing to
// act on. Their testnet Gateway does flap: measured answering in 0.7s, then
// failing to connect twice in a row, then healthy again.
function gatewayUnavailable(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  return /maximum retry attempts|request timed out|gateway api error/i.test(raw);
}

type SolanaChoice = ReturnType<typeof listSolanaWallets>[number];
type EvmChoice = { connector: Connector };

// Which of the payer's wallets pays.
//
// A separate question from which chain, and it has to be asked out loud. The
// flow used to answer it by grabbing whatever was already connected: on EVM
// that was whichever extension wagmi had auto-reconnected, and on Solana it was
// a fixed preference order in lib/solana-wallet.ts. Someone holding USDC in
// their second wallet had no way to reach it and no way to disconnect the
// first.
function WalletSheet({
  kind,
  solanaWallets,
  evmConnectors,
  connectedEvmId,
  onPick,
  onClose,
}: {
  kind: SourceKind;
  solanaWallets: SolanaChoice[];
  evmConnectors: Connector[];
  connectedEvmId?: string;
  onPick: (pick: { solana?: SolanaChoice; evm?: EvmChoice }) => void;
  onClose: () => void;
}) {
  const isSolana = kind === "solana";
  return (
    // z-[60], above the mobile bottom nav.
    //
    // That nav is `fixed bottom-0 ... z-50` and this sheet was z-50 too, so at
    // the same stacking level the nav painted over a bottom-anchored sheet.
    // On a phone that hid the wallet list and the "no wallet found" line under
    // the Send/Create/Links/History bar, leaving a header and blank space.
    // The padding below keeps the last row clear of the nav and the home
    // indicator even when the list is long enough to scroll.
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Choose a wallet"
    >
      <div
        className="w-full max-w-md bg-surface border-t border-x border-border max-h-[75vh] overflow-y-auto sheet-up
                   pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-surface border-b border-border px-4 py-3 flex items-center justify-between">
          <p className="font-mono text-[11px] uppercase tracking-widest text-ink-dim">
            Pay from {SOURCE_CHAIN_LABELS[kind]} with
          </p>
          <button
            onClick={onClose}
            className="text-ink-dim hover:text-ink font-mono text-sm leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <ul>
          {isSolana
            ? solanaWallets.map((w) => (
                <li key={w.id}>
                  <button
                    onClick={() => onPick({ solana: w })}
                    className="w-full px-4 py-3.5 flex items-center justify-between text-left
                               border-b border-border/60 hover:bg-signal/5 transition-colors"
                  >
                    <span className="flex items-center gap-3">
                      {/* The wallet's own icon, when it registered one. */}
                      {w.icon ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={w.icon} alt="" className="w-5 h-5 shrink-0" />
                      ) : (
                        <span className="w-5 h-5 shrink-0" aria-hidden />
                      )}
                      <span className="font-mono text-sm text-ink">{w.label}</span>
                    </span>
                    {/* Phantom is listed but cannot finish a Gateway deposit --
                        it refuses to signMessage a transaction-shaped payload.
                        Saying so here beats letting someone pick it and fail at
                        the signature, which is what used to happen. */}
                    {!w.gatewayCapable && (
                      <span className="font-mono text-[10px] text-danger uppercase tracking-wider">
                        can&apos;t sign cross-chain
                      </span>
                    )}
                  </button>
                </li>
              ))
            : evmConnectors.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => onPick({ evm: { connector: c } })}
                    className="w-full px-4 py-3.5 flex items-center justify-between text-left
                               border-b border-border/60 hover:bg-signal/5 transition-colors"
                  >
                    <span className="font-mono text-sm text-ink">
                      {c.id === CIRCLE_CONNECTOR_ID ? "Google sign-in" : c.name}
                    </span>
                    {c.id === connectedEvmId && (
                      <span className="font-mono text-[10px] text-ink-dim uppercase tracking-wider">
                        connected
                      </span>
                    )}
                  </button>
                </li>
              ))}
        </ul>

        {isSolana && solanaWallets.length === 0 && (
          <p className="px-4 py-6 text-sm text-ink-dim">
            No Solana wallet found in this browser. Install one, then reopen this page.
          </p>
        )}
      </div>
    </div>
  );
}

function stageOf(phase: Phase): BridgeStage {
  if (phase === "settled") return "done";
  // error included: the payer has signed and money may well have moved, so this
  // is not "setup" any more even though it is not finished either.
  if (phase === "spending" || phase === "bridging" || phase === "error") return "paying";
  return "setup";
}

export function CrossChainBridge({ intentId, intent, knownUsdc, onStage }: CrossChainBridgeProps) {
  const [phase, setPhase] = useState<Phase>("choose_source");
  const [adapter, setAdapter] = useState<PayerAdapter | null>(null);
  const [unified, setUnified] = useState<UnifiedUsdc | null>(null);
  const [requiredUSDC, setRequiredUSDC] = useState<string | null>(null);
  const [recipient, setRecipient] = useState<string | null>(null);
  const [intentStatus, setIntentStatus] = useState(intent.status);
  // Which chain the payer pays from. The spend draws from ONE chain, so this is
  // a real choice, not a display detail — defaulted to the richest funded chain
  // and overridable whenever more than one can cover the amount.
  // Which chains fund this payment, and how much from each, richest first.
  //
  // This was a single `sourceChain`, because a spend could only draw from one.
  // Circle Gateway pools deposited balance across chains behind one signature,
  // so it is a list -- usually of length one, and the UI still names the head
  // of it as "the" chain when it is.
  const [allocations, setAllocations] = useState<Array<{ chain: string; minor: bigint }>>([]);
  const sourceChain = allocations[0]?.chain ?? null;
  const [pickerOpen, setPickerOpen] = useState(false);
  // The chain the payer picked, held while they choose WHICH WALLET pays from
  // it. Two decisions, asked separately: "where is my USDC" and "which of my
  // wallets holds it" are different questions, and answering the first used to
  // silently answer the second by grabbing whatever was already connected.
  const [walletPickerFor, setWalletPickerFor] = useState<SourceKind | null>(null);
  // What the wallet is being asked to do right now (e.g. approve a network
  // switch), so the spinner isn't silent while a wallet prompt is waiting.
  const [fxNote, setFxNote] = useState("");
  const [error, setError] = useState("");
  const [mintTx, setMintTx] = useState("");
  // A canceller, not a timer id: the poll below backs off, so there is no
  // single interval to clear.
  const pollRef = useRef<(() => void) | null>(null);

  const { connector, address: evmAddress, isConnected: evmConnected } = useAccount();
  // Who is already paying. This component used to be the thing that connected
  // a wallet; the nav does that now, so its job here is to use the answer.
  const { identity } = usePayerIdentity();
  const { connectAsync, connectors } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const [solanaWallets, setSolanaWallets] = useState<ReturnType<typeof listSolanaWallets>>([]);
  // Detected after mount, never during render: extensions inject on their own
  // schedule and reading window during SSR is a hydration mismatch.
  useEffect(() => setSolanaWallets(listSolanaWallets()), []);
  const hasSolanaWallet = solanaWallets.length > 0;
  // One entry per connector id. wagmi's EIP-6963 discovery can surface the same
  // extension twice (once discovered, once as the generic `injected`), and a
  // list with "MetaMask" in it twice is worse than useless when the whole point
  // of this sheet is telling your wallets apart.
  const evmConnectors = useMemo(() => {
    const seen = new Set<string>();
    return connectors.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  }, [connectors]);

  useEffect(() => {
    return () => {
      pollRef.current?.();
    };
  }, []);

  // Report the stage up. In an effect rather than from the setPhase calls so
  // there is exactly one place it can be forgotten, and it cannot fire during
  // a render of the parent.
  const stage = stageOf(phase);
  useEffect(() => {
    onStage?.(stage);
    // onStage is a callback prop; depending on it would re-fire on every parent
    // render for callers that pass an inline arrow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  // Reset when the intent changes — never let one payment's bridge state render
  // on another's page.
  useEffect(() => {
    pollRef.current?.();
    setPhase("choose_source");
    setAdapter(null);
    setUnified(null);
    setRequiredUSDC(null);
    setRecipient(null);
    setError("");
    setMintTx("");
    setIntentStatus(intent.status);
  }, [intentId, intent.status]);

  // Skip the chain picker when a wallet is already connected.
  //
  // The payer connected at the top of the page and the balance read already
  // knows which chains hold their USDC, so "choose the chain your USDC is on"
  // asks a question the app can answer itself -- and asking it right after a
  // successful connect reads as though the connect did not register.
  //
  // Once per intent, and only from the entry phase: a payer who deliberately
  // goes back to the picker must not be bounced straight out of it again.
  const autoStarted = useRef(false);
  useEffect(() => {
    autoStarted.current = false;
  }, [intentId]);
  useEffect(() => {
    if (autoStarted.current || phase !== "choose_source") return;
    const solProvider = getSolanaProvider();
    if (solProvider?.publicKey) {
      const opt = solanaWallets.find((w) => w.provider === solProvider) ?? solanaWallets[0];
      autoStarted.current = true;
      void chooseSource("solana", undefined, opt ? { solana: opt } : undefined);
      return;
    }
    if (evmConnected && connector) {
      autoStarted.current = true;
      void chooseSource("evm", undefined, { evm: { connector } as EvmChoice });
    }
    // chooseSource is a stable function declaration in this component body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, evmConnected, connector, solanaWallets, intentId]);

  // Drop the current wallet and ask again.
  //
  // Both halves matter. Clearing the adapter alone would leave the extension
  // still connected, so re-picking the same family would silently reuse it --
  // which is the bug this whole sheet exists to fix.
  async function switchWallet() {
    const kind = sourceChain ? chainToSourceSlug(sourceChain) : null;
    setAdapter(null);
    setUnified(null);
    setError("");
    try {
      if (kind === "solana") {
        await disconnectSolanaWallet();
      } else if (evmConnected) {
        await disconnectAsync();
      }
    } catch {
      // A wallet that refuses to disconnect must not trap the payer on this
      // screen; the picker below still lets them choose another one.
    }
    if (kind) {
      setPhase("choose_source");
      openWalletPicker(kind as SourceKind);
    } else {
      setPhase("choose_source");
    }
  }

  // disconnectWallet stood here, offering "Disconnect" on the confirm and
  // insufficient screens. Removed with them: disconnecting is the nav's job, and
  // a payment in progress having its own copy meant two controls disagreeing
  // about one connection -- which is how a payer ended up connected at the top
  // of the page and asked to connect at the bottom of it.

  function startPolling() {
    pollRef.current?.();
    // Ramped, not flat. A flat 3s interval was slower than necessary while the
    // mint was most likely to land, and more expensive than necessary for the
    // ten minutes a bad day can take. pollWithBackoff also runs one tick at a
    // time, so a slow response cannot stack requests behind it.
    pollRef.current = pollWithBackoff(async () => {
      const fresh = await getPublicSettlementIntent(intentId);
      setIntentStatus(fresh.status);
      if (fresh.status !== "settled") return false;

      setPhase("settled");
      // Surface the on-chain Arc mint so the payer can verify the money
      // actually moved -- the same "View on ArcScan" proof the direct
      // (non-bridged) receipt gives. Best-effort: a missing hash just
      // hides the link.
      getBridgeStatus(intentId)
        .then((st) => setMintTx(st.mint_tx_hash ?? ""))
        .catch(() => {});
      return true; // settled is terminal
    });
  }

  // Build the chosen wallet's adapter, read the plan (how much USDC to spend +
  // where to mint) and the payer's unified USDC balance, then confirm or report
  // that there isn't enough across all their chains.
  // `pickedWallet` is the one the payer chose in the wallet sheet. It is passed in
  // rather than read from state for the same reason `picked` is: both are set in
  // the click handler that calls this, and neither has flushed yet.
  // Ask which wallet only when there is actually a choice to make.
  //
  // Wallet discovery finds browser EXTENSIONS -- the Wallet Standard registry,
  // with a window scan behind it. A phone's browser has none, so the list comes
  // back empty and the sheet had nothing to draw: on mobile it opened a panel
  // with a header and no options, which is worse than not opening at all. (The
  // "no wallet found" line underneath it was there, and sat behind the fixed
  // bottom nav, so it could not be read either.)
  //
  // One wallet is not a choice, so that connects straight through. Zero means
  // the question cannot be answered here at all, so say what to do instead of
  // presenting an empty list. More than one is the case the picker exists for:
  // a payer with both Phantom and Solflare, who used to get whichever one won
  // the injection race.
  function openWalletPicker(kind: SourceKind) {
    const options: unknown[] = kind === "solana" ? solanaWallets : evmConnectors;

    if (options.length === 0) {
      setError(
        kind === "solana"
          ? "No Solana wallet is available in this browser. On a phone, open this page inside your wallet's own browser (Phantom or Solflare), then try again."
          : "No wallet is available in this browser. On a phone, open this page inside your wallet's own browser, then try again."
      );
      setPhase("choose_source");
      return;
    }

    if (options.length === 1) {
      const only =
        kind === "solana"
          ? { solana: solanaWallets[0] }
          : { evm: { connector: evmConnectors[0] } as EvmChoice };
      void chooseSource(kind === "solana" ? "solana" : "evm", SOURCE_CHAINS[kind], only);
      return;
    }

    setWalletPickerFor(kind);
  }

  // The wallet is already connected; stop asking which one.
  //
  // choose_source was the entry phase for everyone, which made sense when this
  // component owned connecting. It no longer does -- the nav connects, and
  // usePayerIdentity already knows both who is paying and (via the balance
  // read) where their USDC is. Asking again after that is asking a question we
  // have the answer to, and on a phone it is a full screen of it.
  //
  // The picker is not gone: it is what "use a different wallet" and the
  // insufficient screen fall back to, and it is still the entry point for a
  // payer who arrived with nothing connected.
  const adopted = useRef(false);
  useEffect(() => {
    if (adopted.current || !identity || adapter) return;
    adopted.current = true;
    void adoptConnected();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.address, identity?.kind, adapter]);

  // Reset the latch when the intent changes, so a second payment on the same
  // page adopts the wallet again rather than falling back to the picker.
  useEffect(() => {
    adopted.current = false;
  }, [intentId]);

  async function adoptConnected() {
    if (!identity) return;
    setError("");
    // Only announce work there is. With balances handed in, all that remains is
    // building an adapter -- microseconds -- so "Connecting your wallet" and
    // "Reading your USDC across chains" were two screens flashing past for a
    // read that no longer happens.
    if (!knownUsdc) setPhase("connecting");
    try {
      let payer: PayerAdapter;
      if (identity.kind === "solana") {
        const provider = getSolanaProvider();
        if (!provider) throw new Error("Solana wallet is no longer available.");
        payer = await buildSolanaAdapter(provider, identity.address);
      } else {
        if (!connector) throw new Error("No connected wallet.");
        payer = await buildEvmAdapter(await connector.getProvider(), identity.address);
      }
      await settleOn(payer);
    } catch (err) {
      // Falling back to the picker rather than to an error screen: whatever
      // went wrong with the connected wallet, choosing another one is a real
      // way forward.
      setError(err instanceof Error ? err.message : "Could not read that wallet.");
      setPhase("choose_source");
    }
  }

  // Everything after "we have a wallet": read the plan and the balances, pick
  // the chain that can actually cover the amount, and land on confirm.
  //
  // Extracted so the connected-wallet path and the picker path cannot drift.
  // They were the same twenty lines twice, and the balance rules in here (one
  // chain must cover the whole amount, a payer's explicit pick outranks the
  // greedy default) are exactly the kind that get fixed in one copy only.
  async function settleOn(payer: PayerAdapter, picked?: string) {
    setAdapter(payer);
      if (!knownUsdc) setPhase("checking_balance");

      // Size against deposited Gateway balance AND raw wallet balance: the
      // wallet portion is deposited on demand at spend time, so counting only
      // the deposited balance falsely reported "found 0" for a payer who holds
      // USDC in their wallet but hasn't pre-deposited into Gateway.
      // The Gateway balance read is allowed to fail.
      //
      // It reports what the payer has ALREADY deposited into Circle Gateway,
      // which is usually nothing: spendUsdcToArc deposits from the wallet on
      // demand, so the wallet balance below is what actually funds the payment.
      // Circle's testnet Gateway API flaps -- observed answering in 0.7s, then
      // failing to connect twice in a row -- and the SDK gives up after ten
      // retries with "Maximum retry attempts (10) exceeded". Letting that kill
      // the whole screen stranded a payer whose USDC was sitting right there in
      // their wallet, readable without Circle being involved at all.
      // Reuse what the caller already read. Only fall back to reading here
      // when nobody handed us an answer -- the picker path, where the wallet
      // was connected inside this component and the page never saw it.
      const [plan, bal] = await Promise.all([
        getBridgePlan(intentId),
        knownUsdc
          ? Promise.resolve(knownUsdc)
          : (async () => {
              const [deposited, wallet] = await Promise.all([
                getUnifiedUsdc(payer).catch((err) => {
                  console.warn("circle gateway balance unavailable, using wallet balance only:", err);
                  return {} as UnifiedUsdc;
                }),
                getWalletUsdc(payer),
              ]);
              return mergeUsdc(deposited, wallet);
            })(),
      ]);
      setRequiredUSDC(plan.required_usdc);
      setRecipient(plan.recipient_address);
      setUnified(bal);

      const need = BigInt(plan.required_usdc);
      const funded = fundedChains(bal);

      // Across chains, not on one of them.
      //
      // This used to demand that a SINGLE chain cover the whole amount, because
      // a spend deposited the full amount on one chain and spent it there. It
      // no longer does: Circle Gateway pools deposited balance across chains and
      // settles the set with one EIP-712 BurnIntentSet signature, so a payer
      // holding 20 on Polygon and 20 on Base can pay 30. routeForAmount owns
      // that arithmetic; this screen just follows it.
      //
      // A payer who picked a chain in the sheet gets it first. That is now a
      // preference about where to draw from FIRST rather than a constraint the
      // whole payment must fit inside, so a pick that cannot cover the amount
      // alone is still honoured -- it simply tops up from the next chain.
      const ordered = picked
        ? [
            ...funded.filter((c) => c.chain === picked),
            ...funded.filter((c) => c.chain !== picked),
          ]
        : funded;
      const route = routeForAmount(need, 0n, ordered);
      if (route.kind === "cross_chain") {
        setAllocations(route.allocations);
        setPhase("confirm");
      } else {
        setAllocations([]);
        setPhase("insufficient");
      }
  }

  async function chooseSource(
    kind: "solana" | "evm",
    picked?: string,
    pickedWallet?: { solana?: SolanaChoice; evm?: EvmChoice }
  ) {
    setError("");
    setPhase("connecting");
    try {
      let payer: PayerAdapter;
      if (kind === "solana") {
        // Solana address, never an ETH address.
        const addr = await connectSolanaWallet(pickedWallet?.solana?.provider);
        const provider = pickedWallet?.solana?.provider ?? getSolanaProvider();
        payer = await buildSolanaAdapter(provider, addr);
      } else {
        const target = pickedWallet?.evm;
        if (!target) throw new Error("Choose a wallet to pay from.");
        // Switch wagmi over when the payer picked a different wallet than the
        // one already connected. Without the disconnect, wagmi keeps the old
        // connector and the payment signs from the wrong account.
        let active = connector;
        let addr = evmAddress;
        if (!evmConnected || connector?.id !== target.connector.id) {
          if (evmConnected) await disconnectAsync();
          const res = await connectAsync({ connector: target.connector });
          active = target.connector;
          addr = res.accounts[0];
        }
        if (!active || !addr) throw new Error("That wallet did not connect.");
        const provider = await active.getProvider();
        payer = await buildEvmAdapter(provider, addr);
      }
      await settleOn(payer, picked);
    } catch (err) {
      const notAvailable =
        err instanceof ConduitApiError && err.code === "not_available";
      // Circle's own retry exhaustion, verbatim, tells the payer nothing they
      // can act on and reads like our bug.
      const raw = err instanceof Error ? err.message : "";
      const gatewayDown = gatewayUnavailable(err);
      setError(
        notAvailable
          ? "Cross-chain payments aren't enabled on this deployment yet. Pay on Arc instead."
          : gatewayDown
            ? "Circle's bridge isn't responding right now. Wait a moment and try again, or pay on Arc instead."
            : raw || "Could not connect wallet"
      );
      setPhase("choose_source");
    }
  }

  async function handleSpend() {
    if (!adapter || !requiredUSDC || !recipient || !unified) return;
    setError("");
    setPhase("spending");
    try {
      const need = BigInt(requiredUSDC);
      // Every chain this payment draws from. Usually one; more when no single
      // chain covers the amount and the payer's Gateway balance has to pool
      // across several. The whole set is signed once (BurnIntentSet), so the
      // number of chains changes how many DEPOSITS are needed, never how many
      // times the payer authorises the payment.
      if (allocations.length === 0) throw new Error("Choose the chain to pay from.");
      // Every funded chain, with its REAL balance, ordered so the chains this
      // payment plans to draw from come first.
      //
      // Not the planned per-chain amounts: those sum to exactly the amount owed,
      // and the deposit has to reach amount + Circle's fee buffer, so a plan
      // summing to the amount can never fund it. The trailing chains are what
      // that buffer comes out of; they are only touched if it is needed.
      const funded = unified ? fundedChains(unified) : [];
      const planned = allocations.map((a) => a.chain);
      const sources = [
        ...planned,
        ...funded.map((c) => c.chain).filter((c) => !planned.includes(c)),
      ].map((chain) => ({
        chain,
        availableMinor: funded.find((c) => c.chain === chain)?.minor ?? 0n,
      }));
      const primary = chainToSourceSlug(allocations[0].chain);
      if (!primary) throw new Error("Balance changed — that chain can no longer fund this.");

      // Gas, checked before signing rather than discovered by retry exhaustion.
      //
      // A Solana deposit pays its fee in SOL, and a wallet funded from Circle's
      // USDC faucet usually has none. Without this the SDK retries the
      // unsubmittable transaction, gives up, and the payer is told Circle's
      // bridge is down -- about a wallet that simply cannot pay for a
      // transaction. Unknown is not empty: a failed read lets the spend try.
      if (adapter.family === "solana") {
        const lamports = await getSolanaLamports(adapter.address);
        if (lamports !== null && lamports < MIN_SOLANA_LAMPORTS) {
          throw new Error(
            "This Solana wallet has no SOL to pay the network fee for the deposit. " +
              "Get devnet SOL from faucet.solana.com, then try again. Your USDC is untouched."
          );
        }
      }

      // A Circle wallet exists per blockchain, and Circle cannot provision one
      // on every chain Gateway supports. Checked here, where the chains are
      // known and the payer can still pick another one — otherwise the network
      // switch fails inside Circle's adapter as an unsupported-method error
      // that says nothing about what went wrong or what to do about it.
      //
      // Planned chains throw; fallback chains are dropped. The distinction
      // matters: a payer whose payment is funded from Base should not be
      // refused because they happen to also hold USDC on a chain Circle cannot
      // provision, and that is exactly what checking the whole list would do.
      const payer = adapter;
      let usable = sources;
      if (connector?.id === CIRCLE_CONNECTOR_ID && payer.family === "evm") {
        const { resolveChainIdentifier } = await import("@circle-fin/unified-balance-kit");
        const holdable = (chain: string) => {
          const def = resolveChainIdentifier(chain as never) as unknown as {
            type?: string;
            chainId?: number;
          };
          if (def?.type !== "evm" || typeof def.chainId !== "number") return true;
          return chainByEvmId(def.chainId) !== undefined;
        };
        for (const chain of planned) {
          if (!holdable(chain)) {
            throw new Error(
              `Signing in with Google can't hold USDC on ${chainLabel(chain)}. ` +
                `Choose a different chain, or connect a wallet that holds USDC there.`
            );
          }
        }
        usable = sources.filter((s) => holdable(s.chain));
      }

      // The network switch that used to happen here has moved into
      // spendUsdcToArc. It could be done once up front while a payment drew
      // from a single chain; now that one payment can deposit from several, the
      // switch has to happen per deposit, which only the deposit loop knows
      // about.
      const result = await spendUsdcToArc({
        payer,
        amountMinor: need,
        recipientAddress: recipient,
        sources: usable,
        onProgress: setFxNote,
      });
      setFxNote("Handing off to settlement…");

      // Hand the Gateway transfer id to the server; it polls the mint and runs
      // the existing StableFX settlement into the merchant's currency.
      if (result.transferId) {
        await reportBridgeSpend(intentId, {
          gateway_transfer_id: result.transferId,
          source_chain: primary,
          usdc_amount: requiredUSDC,
        });
      }

      setPhase("bridging");
      startPolling();
    } catch (err) {
      // The raw cause, kept. gatewayUnavailable below matches three strings
      // Circle's SDK emits, so a failure of ours that happens to contain one
      // would be reported as Circle being down and leave nothing to debug.
      console.error("cross-chain spend failed:", err);
      // Checked FIRST. Once the deposit has moved, no generic classifier gets
      // to describe the payer's money -- "nothing has left your wallet" was
      // being printed over a completed deposit.
      const fundsMoved = err instanceof FundsInGatewayError;
      const message = fundsMoved
        ? err.message
        : gatewayUnavailable(err)
        ? "Circle's bridge isn't responding right now. Nothing has left your wallet — wait a moment and try again."
        : err instanceof ConduitApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Payment failed to start";
      setError(message);
      setPhase("error");
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (phase === "choose_source") {
    return (
      <div className="space-y-4">
        <p className="text-ink-dim text-sm">
          This payment settles on Arc, but you can pay with USDC you already hold on another chain.
          Pick where your USDC is — Conduit bridges it and converts to {isoToToken(intent.settle_currency)} for you.
        </p>

        {/* One button, then a list of chains.
            The old version asked the payer to choose between "Solana" and "any
            EVM chain (connected wallet)" — a distinction about wallet plumbing,
            not about where their money is. The only thing a payer knows is
            which chain holds their USDC, so ask exactly that. */}
        <button
          onClick={() => setPickerOpen(true)}
          className="w-full py-4 bg-signal text-signal-ink font-mono hover:bg-signal/90 transition-colors"
        >
          Choose the chain your USDC is on
        </button>
        {error && <p className="text-danger text-sm">{error}</p>}

        {pickerOpen && (
          <div
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/70"
            onClick={() => setPickerOpen(false)}
            role="dialog"
            aria-modal="true"
            aria-label="Choose a chain"
          >
            {/* Slides up from the bottom: this is most often a phone, and the
                bottom of the screen is where a thumb already is. */}
            <div
              className="w-full max-w-md bg-surface border-t border-x border-border max-h-[75vh] overflow-y-auto sheet-up"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sticky top-0 bg-surface border-b border-border px-4 py-3 flex items-center justify-between">
                <p className="font-mono text-[11px] uppercase tracking-widest text-ink-dim">
                  Where is your USDC?
                </p>
                <button
                  onClick={() => setPickerOpen(false)}
                  className="text-ink-dim hover:text-ink font-mono text-sm leading-none"
                  aria-label="Close"
                >
                  ×
                </button>
              </div>

              <ul>
                {(Object.keys(SOURCE_CHAINS) as SourceKind[]).map((kind) => {
                  // Solana needs its own wallet; everything else uses the
                  // connected EVM wallet. Disabled rather than hidden, so a
                  // payer who expected Solana learns why it is unavailable.
                  const isSolana = kind === "solana";
                  const disabled = isSolana && !hasSolanaWallet;
                  return (
                    <li key={kind}>
                      <button
                        disabled={disabled}
                        onClick={() => {
                          setPickerOpen(false);
                          // The chain the payer names is passed to chooseSource
                          // as a preference, and settleOn puts it at the head of
                          // the draw. It is no longer pinned into state here as
                          // "the" source chain, because the balance read may
                          // legitimately fund the payment from this chain plus
                          // others.
                          // Ask which wallet next, rather than connecting one.
                          // Picking a chain used to grab whatever was already
                          // connected, so a payer with two wallets could not
                          // choose and could not switch. openWalletPicker only
                          // asks when there is more than one to choose from.
                          openWalletPicker(kind);
                        }}
                        className="w-full px-4 py-3.5 flex items-center justify-between text-left
                                   border-b border-border/60 hover:bg-signal/5 transition-colors
                                   disabled:opacity-40 disabled:hover:bg-transparent"
                      >
                        <span className="flex items-center gap-3">
                          <ChainIcon kind={kind} />
                          <span className="font-mono text-sm text-ink">
                            {SOURCE_CHAIN_LABELS[kind]}
                          </span>
                        </span>
                        <span className="font-mono text-[10px] text-ink-dim uppercase tracking-wider">
                          {disabled ? "wallet needed" : isSolana ? "Solana wallet" : "EVM wallet"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}

        {walletPickerFor && (
          <WalletSheet
            kind={walletPickerFor}
            solanaWallets={solanaWallets}
            evmConnectors={evmConnectors}
            connectedEvmId={evmConnected ? connector?.id : undefined}
            onClose={() => setWalletPickerFor(null)}
            onPick={(pick) => {
              const kind = walletPickerFor;
              setWalletPickerFor(null);
              void chooseSource(
                kind === "solana" ? "solana" : "evm",
                SOURCE_CHAINS[kind],
                pick
              );
            }}
          />
        )}
      </div>
    );
  }

  if (phase === "connecting" || phase === "checking_balance") {
    // Nothing at all when a wallet is already connected. The read is either
    // cached or skipped entirely in that case, so the screen existed only long
    // enough to flash past -- which reads as a glitch, not as progress.
    if (identity) return null;
    return (
      <div className="text-center py-8 space-y-3">
        <Rocket size={56} />
        <p className="text-ink font-mono text-sm">
          {phase === "connecting" ? "Connecting your wallet…" : "Reading your USDC across chains…"}
        </p>
      </div>
    );
  }

  if (phase === "insufficient") {
    return (
      <div className="space-y-4">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 border border-border bg-surface">
          <span className="w-1.5 h-1.5 bg-signal animate-pulse" />
          <span className="text-ink-dim text-xs font-mono">Connected</span>
          <span className="text-ink text-xs font-mono">
            {adapter?.address ? `${adapter.address.slice(0, 5)}…${adapter.address.slice(-4)}` : "—"}
          </span>
        </div>
        {/* The total, across chains.
            This deliberately showed the LARGEST SINGLE CHAIN and told the payer
            "a payment draws from a single chain, so top one up" -- correct while
            that was true, and now simply wrong: Gateway pools the balance, so
            the number that matters is the sum and the gap is against the sum.
            Showing the per-chain figure here would understate what they have
            and ask them to fix a problem they do not have. */}
        <p className="text-danger text-sm">
          {(() => {
            const funded = unified ? fundedChains(unified) : [];
            const across = funded.reduce((sum, c) => sum + c.minor, 0n);
            const short = BigInt(requiredUSDC ?? "0") - across;
            return funded.length === 0
              ? `You need ${usdcDisplay(BigInt(requiredUSDC ?? "0"))} USDC. Conduit found none on any supported chain.`
              : `You need ${usdcDisplay(BigInt(requiredUSDC ?? "0"))} USDC and hold ` +
                `${usdcDisplay(across)} across ${funded.length === 1 ? chainLabel(funded[0].chain) : `${funded.length} chains`}` +
                `${short > 0n ? ` — ${usdcDisplay(short)} short` : ""}. ` +
                `Top up any of them; a payment can draw from all of them at once.`;
          })()}
        </p>
        {unified && fundedChains(unified).length > 0 && (
          <p className="text-ink-dim text-xs font-mono">
            {fundedChains(unified)
              .map((c) => `${chainLabel(c.chain)} ${usdcDisplay(c.minor)}`)
              .join(" · ")}
          </p>
        )}
        {/* This said "use a different wallet" and sent the payer back to the
            CHAIN list, which was the only screen that existed. It now does what
            it says.

            Disconnect belongs here most of all: "you don't have enough USDC" is
            where someone who connected the wrong wallet actually finds out, and
            offering only "pick another" leaves the wrong one connected. */}
        <button
          onClick={() => void switchWallet()}
          className="text-xs font-mono text-ink-dim hover:text-ink"
        >
          ← Use a different wallet
        </button>
        <button
          onClick={() => setPhase("choose_source")}
          className="block text-xs font-mono text-ink-dim hover:text-ink"
        >
          ← Start from a different chain
        </button>
      </div>
    );
  }

  if (phase === "confirm") {
    const funded = unified ? fundedChains(unified) : [];
    const need = BigInt(requiredUSDC ?? "0");
    // The whole cross-chain balance this payment can draw on, and the chains it
    // will actually draw from. Both are real now: the balance pools across
    // chains, and the draw may span several of them.
    const spendable = funded.reduce((sum, c) => sum + c.minor, 0n);
    const drawing = allocations.length > 0 ? allocations : funded.slice(0, 1);
    const fromLabel =
      drawing.length === 0
        ? "your balance"
        : drawing.length === 1
          ? chainLabel(drawing[0].chain)
          : `${drawing.length} chains`;
    return (
      <div className="space-y-4">
        {/* The payment, not the plumbing.
            This led with a "Connected 3KyT…g6nd" chip, duplicating the nav, and
            then labelled the amount "Paying with" -- so the largest text on the
            last screen before signing was a wallet address, and the route the
            money takes was a footnote. What a payer needs here is what leaves,
            where it leaves from, and what lands. */}
        <div className="border border-border bg-surface p-5 space-y-4">
          <div>
            <p className="text-ink-dim text-xs uppercase tracking-wider font-mono">You pay</p>
            <p className="text-ink font-mono text-3xl mt-1">
              {usdcDisplay(BigInt(requiredUSDC ?? "0"))} USDC
            </p>
            {/* The balance, unified. Naming one chain's balance here was
                honest while a payment could only draw from one chain; it now
                understates what the payer can spend. */}
            <p className="text-ink-dim text-xs font-mono mt-1">
              from {fromLabel} · {usdcDisplay(spendable)} USDC available
            </p>
          </div>

          <div className="h-px bg-border" />

          {/* The hops, named. A payer who can see Base then Arc then EURC
              understands why this takes longer than a same chain send, which is
              the single most common thing to be confused about here. */}
          <div className="flex items-center gap-2 font-mono text-xs text-ink-dim flex-wrap">
            <span className="text-ink">{fromLabel}</span>
            <span aria-hidden>→</span>
            <span className="text-ink">Arc</span>
            {isoToToken(intent.settle_currency) !== "USDC" && (
              <>
                <span aria-hidden>→</span>
                <span className="text-ink">{isoToToken(intent.settle_currency)}</span>
              </>
            )}
          </div>

          <div className="h-px bg-border" />

          <div>
            <p className="text-ink-dim text-xs uppercase tracking-wider font-mono">They receive</p>
            <p className="text-signal font-mono text-xl mt-1">
              {/* formatAmount, not usdcDisplay: that one is 6dp by definition
                  and three settle tokens (BRLA, ZARU, KRW1) are 18, which would
                  misprint the recipient's amount by a factor of a trillion. */}
              {formatAmount(
                BigInt(intent.amount),
                isoToToken(intent.settle_currency) as Currency,
              )}
            </p>
          </div>
        </div>

        {/* Where the money is coming from, and what it costs.
            Every funded chain is selectable now -- an under-funded one used to
            be greyed out because a payment had to fit inside one chain, and it
            no longer does: picking it just means "start here", and the rest is
            topped up from the chains below. Chains the payment will actually
            draw from are marked, with the amount drawn, because that is what
            decides how many deposits the payer is about to approve. */}
        {funded.length > 1 && (
          <div className="space-y-2">
            <p className="text-ink-dim text-xs uppercase tracking-wider font-mono">Pay from</p>
            {funded.map((c) => {
              const drawn = allocations.find((a) => a.chain === c.chain)?.minor ?? 0n;
              const active = drawn > 0n;
              const first = allocations[0]?.chain === c.chain;
              return (
                <button
                  key={c.chain}
                  // Reorders the draw to start here, then refills from the rest.
                  onClick={() => {
                    const reordered = [
                      ...funded.filter((f) => f.chain === c.chain),
                      ...funded.filter((f) => f.chain !== c.chain),
                    ];
                    const r = routeForAmount(need, 0n, reordered);
                    if (r.kind === "cross_chain") setAllocations(r.allocations);
                  }}
                  className={`w-full flex items-center justify-between px-4 py-3 border font-mono text-sm
                    transition-colors ${
                      active
                        ? "border-signal bg-signal/10 text-ink"
                        : "border-border text-ink hover:border-signal/40"
                    }`}
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={`w-1.5 h-1.5 ${first ? "bg-signal" : active ? "bg-signal/50" : "bg-transparent border border-ink-dim"}`}
                    />
                    {chainLabel(c.chain)}
                  </span>
                  <span className={active ? "text-ink" : "text-ink-dim"}>
                    {active ? `${usdcDisplay(drawn)} of ` : ""}
                    {usdcDisplay(c.minor)} USDC
                  </span>
                </button>
              );
            })}
            {allocations.length > 1 && (
              <p className="text-ink-dim text-xs font-mono">
                Drawing from {allocations.length} chains. One signature covers all of
                them; each chain needs its own deposit first.
              </p>
            )}
          </div>
        )}
        <button
          onClick={handleSpend}
          className="w-full py-4 bg-signal text-signal-ink font-mono hover:bg-signal/90 transition-colors"
        >
          Pay {usdcDisplay(BigInt(requiredUSDC ?? "0"))} USDC
        </button>
        {/* Changing wallet stays -- this is the last moment before signing, and
            the address about to spend is named above, so this is where a payer
            notices it is not the one they meant. Disconnecting does not: it
            lives in the nav, and a second control for it mid payment meant two
            places disagreeing about one connection. */}
        <div className="flex items-center justify-center">
          <button
            onClick={() => void switchWallet()}
            className="text-xs font-mono text-ink-dim hover:text-ink"
          >
            Pay from a different wallet
          </button>
        </div>
        {error && <p className="text-danger text-sm">{error}</p>}
      </div>
    );
  }

  if (phase === "spending") {
    return (
      <div className="text-center py-8 space-y-3">
        <Rocket size={56} />
        <p className="text-ink font-mono text-sm">{fxNote || "Confirm in your wallet…"}</p>
      </div>
    );
  }

  if (phase === "bridging" || phase === "settled" || phase === "error") {
    const step2Done = intentStatus === "settled";
    const settleToken = isoToToken(intent.settle_currency);
    // Every chain the payment drew from, not just the first. A receipt that
    // said "Paid from Base" for a payment that also took 12 USDC off Polygon
    // would be a false record of where the money went.
    const from =
      allocations.length === 0
        ? null
        : allocations.map((a) => chainLabel(a.chain)).join(" + ");

    // Settled gets a receipt, not a sentence.
    //
    // It used to be "Settled. Thank you." over a progress list. That is the one
    // moment the payer wants the facts back -- how much left, from where, who
    // has it now -- and it is also the screen they screenshot when something
    // later goes wrong. A thank you is not a record.
    if (phase === "settled" && step2Done) {
      return (
        <div className="space-y-5">
          <div className="flex flex-col items-center gap-2">
            <Rocket state="launch" size={56} />
            <p className="text-signal font-mono text-lg">Paid</p>
          </div>

          <dl className="border border-border bg-surface divide-y divide-border font-mono text-sm">
            <Fact label="Amount" value={`${usdcDisplay(BigInt(requiredUSDC ?? "0"))} USDC`} />
            {from && <Fact label="Paid from" value={from} />}
            <Fact label="Settled in" value={settleToken} />
            {recipient && <Fact label="To" value={shortenAddress(recipient)} />}
          </dl>

          {mintTx && (
            <a
              href={`https://testnet.arcscan.app/tx/${mintTx}`}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full py-3 text-center text-scale-2 font-mono
                         border border-border text-ink-dim
                         hover:text-ink hover:border-ink-dim transition-colors"
            >
              View on ArcScan →
            </a>
          )}
        </div>
      );
    }

    // One line, not a checklist.
    //
    // This was a two step progress list, and it never ticked: step one was
    // rendered done only when step two was, and by the time step two is done
    // this branch has been replaced by the receipt above. So the list showed
    // "1" and "2" un-ticked for the entire transfer and then vanished -- a
    // progress indicator that could not indicate progress, ahead of a receipt
    // that says everything it was gesturing at. The wait itself still needs
    // something on screen, so this says what is happening and that leaving is
    // safe, and nothing else.
    return (
      <div className="space-y-4">
        {phase !== "error" && (
          <div className="text-center py-8 space-y-3">
            <Rocket size={56} />
            <p className="text-ink font-mono text-sm">
              {from ? `Bridging your USDC from ${from} to Arc…` : "Bridging your USDC to Arc…"}
            </p>
            {/* Worth saying, because it is true and because watching a spinner
                you believe you must not interrupt is its own kind of cost. The
                transfer is tracked server side through deposit, mint and
                handoff, with orphan recovery, so it resumes rather than being
                lost. */}
            <p className="text-ink-dim text-xs font-mono max-w-xs mx-auto">
              Converting to {settleToken} on arrival — no second signature. You can
              close this page; it settles without you.
            </p>
          </div>
        )}

        {error && (
          <div className="space-y-3">
            <p className="text-danger text-sm">{error}</p>
            <button
              onClick={() => void adoptConnected()}
              className="w-full py-3 border border-border font-mono text-sm
                         text-ink-dim hover:text-ink hover:border-ink-dim transition-colors"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    );
  }

  return null;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <dt className="text-ink-dim text-xs uppercase tracking-wider">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}
