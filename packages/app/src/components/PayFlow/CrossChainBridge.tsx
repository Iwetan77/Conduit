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
import { useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { getSolanaProvider, connectSolanaWallet } from "@/lib/solana-wallet";
import {
  getBridgePlan,
  reportBridgeSpend,
  getPublicSettlementIntent,
  getBridgeStatus,
  ConduitApiError,
  type PublicSettlementIntent,
} from "@/lib/conduit-api";
import { isoToToken } from "@/lib/currencies";
import {
  buildEvmAdapter,
  ensureEvmChain,
  buildSolanaAdapter,
  getUnifiedUsdc,
  getWalletUsdc,
  mergeUsdc,
  spendUsdcToArc,
  planAllocations,
  usdcMinorToHuman,
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

interface CrossChainBridgeProps {
  intentId: string;
  intent: PublicSettlementIntent;
}

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

const POLL_INTERVAL_MS = 3000;

export function CrossChainBridge({ intentId, intent }: CrossChainBridgeProps) {
  const [phase, setPhase] = useState<Phase>("choose_source");
  const [adapter, setAdapter] = useState<PayerAdapter | null>(null);
  const [unified, setUnified] = useState<UnifiedUsdc | null>(null);
  const [requiredUSDC, setRequiredUSDC] = useState<string | null>(null);
  const [recipient, setRecipient] = useState<string | null>(null);
  const [intentStatus, setIntentStatus] = useState(intent.status);
  // Which chain the payer pays from. The spend draws from ONE chain, so this is
  // a real choice, not a display detail — defaulted to the richest funded chain
  // and overridable whenever more than one can cover the amount.
  const [sourceChain, setSourceChain] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // What the wallet is being asked to do right now (e.g. approve a network
  // switch), so the spinner isn't silent while a wallet prompt is waiting.
  const [fxNote, setFxNote] = useState("");
  const [error, setError] = useState("");
  const [mintTx, setMintTx] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { connector, address: evmAddress, isConnected: evmConnected } = useAccount();
  const hasPhantom = typeof window !== "undefined" && !!getSolanaProvider();

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Reset when the intent changes — never let one payment's bridge state render
  // on another's page.
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    setPhase("choose_source");
    setAdapter(null);
    setUnified(null);
    setRequiredUSDC(null);
    setRecipient(null);
    setError("");
    setMintTx("");
    setIntentStatus(intent.status);
  }, [intentId, intent.status]);

  function startPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const fresh = await getPublicSettlementIntent(intentId);
        setIntentStatus(fresh.status);
        if (fresh.status === "settled") {
          setPhase("settled");
          if (pollRef.current) clearInterval(pollRef.current);
          // Surface the on-chain Arc mint so the payer can verify the money
          // actually moved -- the same "View on ArcScan" proof the direct
          // (non-bridged) receipt gives. Best-effort: a missing hash just
          // hides the link.
          getBridgeStatus(intentId)
            .then((s) => setMintTx(s.mint_tx_hash ?? ""))
            .catch(() => {});
        }
      } catch {
        // transient — keep polling
      }
    }, POLL_INTERVAL_MS);
  }

  // Build the chosen wallet's adapter, read the plan (how much USDC to spend +
  // where to mint) and the payer's unified USDC balance, then confirm or report
  // that there isn't enough across all their chains.
  async function chooseSource(kind: "solana" | "evm", picked?: string) {
    setError("");
    setPhase("connecting");
    try {
      let payer: PayerAdapter;
      if (kind === "solana") {
        const addr = await connectSolanaWallet(); // Phantom, Solana address — never an ETH address
        payer = await buildSolanaAdapter(getSolanaProvider(), addr);
      } else {
        if (!evmConnected || !evmAddress || !connector) {
          throw new Error("Connect an EVM wallet first to pay from an EVM chain.");
        }
        const provider = await connector.getProvider();
        payer = await buildEvmAdapter(provider, evmAddress);
      }
      setAdapter(payer);
      setPhase("checking_balance");

      // Size against deposited Gateway balance AND raw wallet balance: the
      // wallet portion is deposited on demand at spend time, so counting only
      // the deposited balance falsely reported "found 0" for a payer who holds
      // USDC in their wallet but hasn't pre-deposited into Gateway.
      const [plan, deposited, wallet] = await Promise.all([
        getBridgePlan(intentId),
        getUnifiedUsdc(payer),
        getWalletUsdc(payer),
      ]);
      const bal = mergeUsdc(deposited, wallet);
      setRequiredUSDC(plan.required_usdc);
      setRecipient(plan.recipient_address);
      setUnified(bal);

      const need = BigInt(plan.required_usdc);
      // Default to the richest chain that can cover this on its own — that's
      // the one the spend would actually succeed from.
      const funded = fundedChains(bal);
      const payable = funded.find((c) => c.minor >= need);
      // The payer picked a chain in the sheet; that choice outranks the greedy
      // default. Without this the pick was read and then thrown away here, and
      // a payer who chose Polygon but held more USDC on Base silently paid from
      // Base. Fall back only when nothing was picked, or when the pick can't
      // cover the amount on its own — the confirm screen then shows what can.
      const pickedFunded = picked ? funded.find((c) => c.chain === picked && c.minor >= need) : undefined;
      setSourceChain(pickedFunded?.chain ?? payable?.chain ?? null);
      if (payable || planAllocations(bal, need)) {
        setPhase("confirm");
      } else {
        setPhase("insufficient");
      }
    } catch (err) {
      const notAvailable =
        err instanceof ConduitApiError && err.code === "not_available";
      setError(
        notAvailable
          ? "Cross-chain payments aren't enabled on this deployment yet. Pay on Arc instead."
          : err instanceof Error
            ? err.message
            : "Could not connect wallet"
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
      // Honour the payer's chosen chain; fall back to the greedy plan only when
      // nothing was picked (single-chain case).
      const chosen = sourceChain
        ? { allocations: [{ chain: sourceChain, amountMinor: need }], primary: chainToSourceSlug(sourceChain) }
        : planAllocations(unified, need);
      if (!chosen?.primary) throw new Error("Balance changed — not enough USDC across your chains.");

      // Depositing from an EVM chain requires the wallet to BE on that chain —
      // the payer is normally sitting on Arc, so without this the SDK rejects
      // the deposit ("chainId should be same as current chainId"). Switch, then
      // rebuild the adapter so it's bound to the network we just moved to.
      let payer = adapter;
      const sourceChainId = chosen.allocations[0]?.chain;

      // A Circle wallet exists per blockchain, and Circle cannot provision one
      // on every chain Gateway supports. Say that here, where the chain is
      // known and the payer can still pick another one — otherwise the switch
      // below fails inside Circle's adapter as an unsupported-method error that
      // says nothing about what went wrong or what to do about it.
      if (connector?.id === CIRCLE_CONNECTOR_ID && payer.family === "evm" && sourceChainId) {
        const { resolveChainIdentifier } = await import("@circle-fin/unified-balance-kit");
        const def = resolveChainIdentifier(sourceChainId as never) as unknown as {
          type?: string;
          chainId?: number;
        };
        if (def?.type === "evm" && typeof def.chainId === "number" && !chainByEvmId(def.chainId)) {
          throw new Error(
            `Signing in with Google can't hold USDC on ${chainLabel(sourceChainId)}. ` +
              `Choose a different chain, or connect a wallet that holds USDC there.`
          );
        }
      }

      if (payer.family === "evm" && sourceChainId) {
        setFxNote(`Switch to ${chainLabel(sourceChainId)} in your wallet…`);
        await ensureEvmChain(payer.provider, sourceChainId);
        payer = await buildEvmAdapter(payer.provider, payer.address);
        setAdapter(payer);
        setFxNote("");
      }

      const result = await spendUsdcToArc({
        payer,
        amountMinor: need,
        recipientAddress: recipient,
        allocations: chosen.allocations,
      });

      // Hand the Gateway transfer id to the server; it polls the mint and runs
      // the existing StableFX settlement into the merchant's currency.
      if (result.transferId) {
        await reportBridgeSpend(intentId, {
          gateway_transfer_id: result.transferId,
          source_chain: chosen.primary,
          usdc_amount: requiredUSDC,
        });
      }

      setPhase("bridging");
      startPolling();
    } catch (err) {
      const message =
        err instanceof ConduitApiError ? err.message : err instanceof Error ? err.message : "Payment failed to start";
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
                  const disabled = isSolana && !hasPhantom;
                  return (
                    <li key={kind}>
                      <button
                        disabled={disabled}
                        onClick={() => {
                          setPickerOpen(false);
                          setSourceChain(SOURCE_CHAINS[kind]);
                          // Passed, not read from state: setSourceChain above
                          // has not flushed by the time chooseSource runs.
                          void chooseSource(isSolana ? "solana" : "evm", SOURCE_CHAINS[kind]);
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
      </div>
    );
  }

  if (phase === "connecting" || phase === "checking_balance") {
    return (
      <div className="text-center py-8 space-y-3">
        <div className="w-10 h-10 border-2 border-signal border-t-transparent animate-spin mx-auto" />
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
        <p className="text-danger text-sm">
          You need {usdcDisplay(BigInt(requiredUSDC ?? "0"))} USDC, but Conduit found only{" "}
          {usdcDisplay(
            (unified ? fundedChains(unified) : []).reduce((sum, c) => sum + c.minor, 0n)
          )}{" "}
          USDC across your chains. Add USDC and try again.
        </p>
        {unified && fundedChains(unified).length > 0 && (
          <p className="text-ink-dim text-xs font-mono">
            {fundedChains(unified)
              .map((c) => `${chainLabel(c.chain)} ${usdcDisplay(c.minor)}`)
              .join(" · ")}
          </p>
        )}
        <button
          onClick={() => setPhase("choose_source")}
          className="text-xs font-mono text-ink-dim hover:text-ink"
        >
          ← Use a different wallet
        </button>
      </div>
    );
  }

  if (phase === "confirm") {
    const funded = unified ? fundedChains(unified) : [];
    const need = BigInt(requiredUSDC ?? "0");
    return (
      <div className="space-y-4">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 border border-border bg-surface">
          <span className="w-1.5 h-1.5 bg-signal animate-pulse" />
          <span className="text-ink-dim text-xs font-mono">Connected</span>
          <span className="text-ink text-xs font-mono">
            {adapter?.address ? `${adapter.address.slice(0, 5)}…${adapter.address.slice(-4)}` : "—"}
          </span>
        </div>
        <div className="border border-border bg-surface p-4 space-y-2">
          <p className="text-ink-dim text-xs uppercase tracking-wider font-mono">Paying with</p>
          <p className="text-ink font-mono text-xl">
            {usdcDisplay(BigInt(requiredUSDC ?? "0"))} USDC
          </p>
          {funded.length === 1 && (
            <p className="text-ink-dim text-xs font-mono">
              from {chainLabel(funded[0].chain)} · {usdcDisplay(funded[0].minor)} USDC available
            </p>
          )}
        </div>

        {/* More than one funded chain — let the payer choose, rather than
            silently spending from whichever happened to sort first. Chains that
            can't cover the amount on their own are shown but not selectable:
            the spend draws from a single chain, so an under-funded one would
            fail at signing time. */}
        {funded.length > 1 && (
          <div className="space-y-2">
            <p className="text-ink-dim text-xs uppercase tracking-wider font-mono">Pay from</p>
            {funded.map((c) => {
              const enough = c.minor >= need;
              const active = c.chain === sourceChain;
              return (
                <button
                  key={c.chain}
                  onClick={() => enough && setSourceChain(c.chain)}
                  disabled={!enough}
                  className={`w-full flex items-center justify-between px-4 py-3 border font-mono text-sm
                    transition-colors ${
                      active
                        ? "border-signal bg-signal/10 text-ink"
                        : enough
                          ? "border-border text-ink hover:border-signal/40"
                          : "border-border text-ink-dim opacity-50 cursor-not-allowed"
                    }`}
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={`w-1.5 h-1.5 ${active ? "bg-signal" : "bg-transparent border border-ink-dim"}`}
                    />
                    {chainLabel(c.chain)}
                  </span>
                  <span className={active ? "text-ink" : "text-ink-dim"}>
                    {usdcDisplay(c.minor)} USDC
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <p className="text-ink-dim text-xs">
          Your USDC moves to Arc, then converts to {isoToToken(intent.settle_currency)} and settles to the recipient.
        </p>
        <button
          onClick={handleSpend}
          className="w-full py-4 bg-signal text-signal-ink font-mono hover:bg-signal/90 transition-colors"
        >
          Pay {usdcDisplay(BigInt(requiredUSDC ?? "0"))} USDC
        </button>
        {error && <p className="text-danger text-sm">{error}</p>}
      </div>
    );
  }

  if (phase === "spending") {
    return (
      <div className="text-center py-8 space-y-3">
        <div className="w-10 h-10 border-2 border-signal border-t-transparent animate-spin mx-auto" />
        <p className="text-ink font-mono text-sm">{fxNote || "Confirm in your wallet…"}</p>
      </div>
    );
  }

  if (phase === "bridging" || phase === "settled" || phase === "error") {
    const step1Done = phase === "bridging" || phase === "settled";
    const step2Done = intentStatus === "settled";
    return (
      <div className="space-y-6">
        <p className="text-ink-dim text-xs font-mono">
          Your USDC is moving to Arc and converting to {isoToToken(intent.settle_currency)}. You won&apos;t need to sign again.
        </p>
        <ol className="space-y-3 font-mono text-sm border border-border bg-surface p-4">
          <BridgeStep n={1} label="Bridging your USDC to Arc" done={step1Done && step2Done} active={step1Done && !step2Done} />
          <BridgeStep n={2} label={`Converting to ${isoToToken(intent.settle_currency)} & settling`} done={step2Done} active={step1Done && !step2Done} />
        </ol>
        {phase === "settled" && (
          <div className="space-y-3">
            <p className="text-signal font-mono">Settled. Thank you.</p>
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
        )}
        {error && <p className="text-danger text-sm">{error}</p>}
      </div>
    );
  }

  return null;
}

function BridgeStep({ n, label, done, active }: { n: number; label: string; done: boolean; active: boolean }) {
  return (
    <li className="flex items-center gap-3">
      <span
        className={`w-6 h-6 flex items-center justify-center border text-xs shrink-0
          ${done ? "bg-signal text-signal-ink border-signal" : active ? "border-signal text-signal" : "border-border text-ink-dim"}`}
      >
        {done ? "✓" : n}
      </span>
      <span className={done || active ? "text-ink" : "text-ink-dim"}>{label}</span>
    </li>
  );
}
