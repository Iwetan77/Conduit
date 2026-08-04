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
  ConduitApiError,
  type PublicSettlementIntent,
} from "@/lib/conduit-api";
import {
  buildEvmAdapter,
  buildSolanaAdapter,
  getUnifiedUsdc,
  getWalletUsdc,
  mergeUsdc,
  spendUsdcToArc,
  planAllocations,
  usdcMinorToHuman,
  type PayerAdapter,
  type UnifiedUsdc,
} from "@/lib/unified-balance";
import { formatAmountRaw } from "@/lib/format";

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
  const [error, setError] = useState("");
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
        }
      } catch {
        // transient — keep polling
      }
    }, POLL_INTERVAL_MS);
  }

  // Build the chosen wallet's adapter, read the plan (how much USDC to spend +
  // where to mint) and the payer's unified USDC balance, then confirm or report
  // that there isn't enough across all their chains.
  async function chooseSource(kind: "solana" | "evm") {
    setError("");
    setPhase("connecting");
    try {
      let payer: PayerAdapter;
      if (kind === "solana") {
        const addr = await connectSolanaWallet(); // Phantom, Solana address — never an ETH address
        payer = await buildSolanaAdapter(getSolanaProvider(), addr);
      } else {
        if (!evmConnected || !evmAddress || !connector) {
          throw new Error("Connect an EVM wallet first to pay from Base or Polygon.");
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
      if (planAllocations(bal, need)) {
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
      const plan = planAllocations(unified, need);
      if (!plan) throw new Error("Balance changed — not enough USDC across your chains.");

      const result = await spendUsdcToArc({
        payer: adapter,
        amountMinor: need,
        recipientAddress: recipient,
        allocations: plan.allocations,
      });

      // Hand the Gateway transfer id to the server; it polls the mint and runs
      // the existing StableFX settlement into the merchant's currency.
      if (result.transferId) {
        await reportBridgeSpend(intentId, {
          gateway_transfer_id: result.transferId,
          source_chain: plan.primary,
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
          Pick where your USDC is — Conduit bridges it and converts to {intent.settle_currency} for you.
        </p>
        <button
          onClick={() => chooseSource("solana")}
          disabled={!hasPhantom}
          className="w-full py-4 bg-signal text-signal-ink font-mono hover:bg-signal/90 transition-colors disabled:opacity-40"
        >
          Pay with USDC on Solana
        </button>
        {!hasPhantom && <p className="text-ink-dim text-xs">Install a Solana wallet (Solflare, Backpack, Phantom) to pay from Solana.</p>}
        <button
          onClick={() => chooseSource("evm")}
          className="w-full py-4 border border-border text-ink font-mono hover:border-signal/40 transition-colors"
        >
          Pay with USDC on Base or Polygon (connected wallet)
        </button>
        {error && <p className="text-danger text-sm">{error}</p>}
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
          You need {formatAmountRaw(BigInt(requiredUSDC ?? "0"), 6)} USDC, but Conduit found only{" "}
          {unified?.totalConfirmed ?? "0"} across your chains. Add USDC and try again.
        </p>
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
            {usdcMinorToHuman(BigInt(requiredUSDC ?? "0"))} USDC
          </p>
          {unified && (
            <p className="text-ink-dim text-xs font-mono">
              from your unified balance ({unified.byChain.map((c) => `${c.confirmed} on ${c.chain}`).join(", ") || "—"})
            </p>
          )}
        </div>
        <p className="text-ink-dim text-xs">
          Your USDC moves to Arc, then converts to {intent.settle_currency} and settles to the recipient.
        </p>
        <button
          onClick={handleSpend}
          className="w-full py-4 bg-signal text-signal-ink font-mono hover:bg-signal/90 transition-colors"
        >
          Pay {usdcMinorToHuman(BigInt(requiredUSDC ?? "0"))} USDC
        </button>
        {error && <p className="text-danger text-sm">{error}</p>}
      </div>
    );
  }

  if (phase === "spending") {
    return (
      <div className="text-center py-8 space-y-3">
        <div className="w-10 h-10 border-2 border-signal border-t-transparent animate-spin mx-auto" />
        <p className="text-ink font-mono text-sm">Confirm in your wallet…</p>
      </div>
    );
  }

  if (phase === "bridging" || phase === "settled" || phase === "error") {
    const step1Done = phase === "bridging" || phase === "settled";
    const step2Done = intentStatus === "settled";
    return (
      <div className="space-y-6">
        <p className="text-ink-dim text-xs font-mono">
          Your USDC is moving to Arc and converting to {intent.settle_currency}. You won&apos;t need to sign again.
        </p>
        <ol className="space-y-3 font-mono text-sm border border-border bg-surface p-4">
          <BridgeStep n={1} label="Bridging your USDC to Arc" done={step1Done && step2Done} active={step1Done && !step2Done} />
          <BridgeStep n={2} label={`Converting to ${intent.settle_currency} & settling`} done={step2Done} active={step1Done && !step2Done} />
        </ol>
        {phase === "settled" && <p className="text-signal font-mono">Settled. Thank you.</p>}
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
