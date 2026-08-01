"use client";

// Cross-chain (Circle Gateway) funding flow for a payer funding a settlement
// intent from Solana USDC. This takes real, variable time and is never
// described as a single immediate step anywhere in this file: it's an
// honest deposit(if needed) -> signed burn intent -> forwarder mint ->
// settle sequence (see docs/ubk-capability.md). The payer signs on Solana
// (a deposit transaction only if their Gateway balance is short, always a
// burn-intent message); everything after that is polled server state, not
// client-driven animation.
import { useEffect, useRef, useState } from "react";
import {
  connectSolanaWallet,
  getSolanaProvider,
  signAndSubmitDeposit,
  signBurnIntent,
} from "@/lib/solana-wallet";
import {
  initiateBridge,
  reportBridgeSignature,
  getBridgeStatus,
  getBridgeBalance,
  getPublicSettlementIntent,
  ConduitApiError,
  type BridgeStatus,
  type PublicSettlementIntent,
} from "@/lib/conduit-api";
import { formatAmountRaw } from "@/lib/format";

interface CrossChainBridgeProps {
  intentId: string;
  intent: PublicSettlementIntent;
}

type Phase = "connect" | "checking_balance" | "insufficient" | "confirm" | "signing" | "bridging" | "settled" | "error";

const POLL_INTERVAL_MS = 2500;

// States from internal/bridge/state.go that count as "step 1 done" (USDC has
// actually minted on Arc) vs "step 3 done" (settlement fully handed off).
const MINTED_OR_LATER = new Set([
  "minted",
  "handoff_to_settlement",
]);

export function CrossChainBridge({ intentId, intent }: CrossChainBridgeProps) {
  const [phase, setPhase] = useState<Phase>("connect");
  const [payerAddress, setPayerAddress] = useState<string | null>(null);
  const [availableBalance, setAvailableBalance] = useState<string | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus | null>(null);
  const [intentStatus, setIntentStatus] = useState(intent.status);
  const [error, setError] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const hasPhantom = typeof window !== "undefined" && !!getSolanaProvider();
  const requiredAmount = intent.amount;

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Orphan-safe: if a bridge for this intent is already in flight (payer
  // reopened the tab after closing it mid-bridge), pick up polling
  // immediately instead of showing the connect/balance screen again.
  useEffect(() => {
    let cancelled = false;
    // Per-intent state must not survive an intent change: bridge phase and
    // status from one payment rendering on another is the same class of bug
    // as showing the wrong merchant.
    if (pollRef.current) clearInterval(pollRef.current);
    setBridgeStatus(null);
    setPayerAddress("");
    setAvailableBalance(null);
    setError("");

    getBridgeStatus(intentId)
      .then((status) => {
        if (cancelled) return;
        setBridgeStatus(status);
        if (status.state !== "failed") {
          setPhase("bridging");
          startPolling();
        }
      })
      .catch(() => {
        // No transfer yet -- expected for a fresh payment link.
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentId]);

  function startPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const [status, freshIntent] = await Promise.all([
          getBridgeStatus(intentId),
          getPublicSettlementIntent(intentId),
        ]);
        setBridgeStatus(status);
        setIntentStatus(freshIntent.status);
        if (freshIntent.status === "settled") {
          setPhase("settled");
          if (pollRef.current) clearInterval(pollRef.current);
        }
        if (status.state === "failed") {
          setError("The bridge could not complete. Your funds are safe on Solana and support has been notified — this page will keep checking.");
        }
      } catch {
        // Transient poll failure -- keep trying, don't flip to an error
        // state over one missed request.
      }
    }, POLL_INTERVAL_MS);
  }

  // Balance-aware paying (Phase 5.1): the payer never picks from a list of
  // assets they don't hold. Conduit checks their real Gateway balance and
  // either confirms "paying with USDC" as a fact or says honestly that
  // there isn't enough, rather than asking them to type an amount.
  async function handleConnect() {
    setError("");
    try {
      const addr = await connectSolanaWallet();
      setPayerAddress(addr);
      setPhase("checking_balance");
      const balance = await getBridgeBalance(intentId, addr);
      const solanaBalance = BigInt(balance.by_chain["solana"] ?? "0");
      setAvailableBalance(solanaBalance.toString());
      if (solanaBalance >= BigInt(requiredAmount)) {
        setPhase("confirm");
      } else {
        setPhase("insufficient");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect Solana wallet");
      setPhase("connect");
    }
  }

  async function handleBridge() {
    if (!payerAddress) return;
    setError("");
    setPhase("signing");
    try {
      const init = await initiateBridge(intentId, payerAddress, requiredAmount);
      if (!init.burn_intent_message) throw new Error("No burn intent returned");

      let depositTxHash: string | undefined;
      if (init.needs_deposit && init.deposit_tx_base64) {
        depositTxHash = await signAndSubmitDeposit(init.deposit_tx_base64);
      }

      const burnIntentSignature = await signBurnIntent(init.burn_intent_message);
      await reportBridgeSignature(intentId, init.transfer_id, burnIntentSignature, depositTxHash);

      setPhase("bridging");
      startPolling();
    } catch (err) {
      const message = err instanceof ConduitApiError ? err.message : err instanceof Error ? err.message : "Bridge failed to start";
      setError(message);
      setPhase("error");
    }
  }

  if (phase === "connect") {
    return (
      <div className="space-y-4">
        <p className="text-ink-dim text-sm">
          This payment settles on Arc, but you&apos;re paying with USDC on Solana.
          Conduit bridges it for you — you&apos;ll sign once, on Solana.
        </p>
        {!hasPhantom && (
          <p className="text-danger text-sm">
            No Solana wallet detected. Install Phantom to continue.
          </p>
        )}
        <button
          onClick={handleConnect}
          disabled={!hasPhantom}
          className="w-full py-4 bg-signal text-signal-ink font-mono text-lg
                     hover:bg-signal/90 transition-colors disabled:opacity-40"
        >
          Connect Solana Wallet
        </button>
        {error && <p className="text-danger text-sm">{error}</p>}
      </div>
    );
  }

  if (phase === "checking_balance") {
    return (
      <div className="text-center py-8 space-y-3">
        <div className="w-10 h-10 border-2 border-signal border-t-transparent animate-spin mx-auto" />
        <p className="text-ink font-mono text-sm">Checking your USDC balance...</p>
      </div>
    );
  }

  if (phase === "insufficient") {
    return (
      <div className="space-y-4">
        <p className="text-ink-dim text-sm">
          Connected: <span className="text-ink font-mono">{payerAddress}</span>
        </p>
        <p className="text-danger text-sm">
          You need {formatAmountRaw(BigInt(requiredAmount), 6)} USDC on Solana, but Conduit found only{" "}
          {formatAmountRaw(BigInt(availableBalance ?? "0"), 6)}. Add more USDC to this wallet and try again.
        </p>
      </div>
    );
  }

  if (phase === "confirm") {
    return (
      <div className="space-y-4">
        <p className="text-ink-dim text-sm">
          Connected: <span className="text-ink font-mono">{payerAddress}</span>
        </p>
        <div className="border border-border bg-surface p-4">
          <p className="text-ink-dim text-xs uppercase tracking-wider font-mono">Paying with</p>
          <p className="text-ink font-mono text-xl">{formatAmountRaw(BigInt(requiredAmount), 6)} USDC</p>
        </div>
        <p className="text-ink-dim text-xs">
          Your USDC is moving from Solana to Arc (~15s), then converts to{" "}
          {intent.settle_currency} and settles. You won&apos;t need to sign again.
        </p>
        <button
          onClick={handleBridge}
          className="w-full py-4 bg-signal text-signal-ink font-mono text-lg hover:bg-signal/90 transition-colors"
        >
          Pay {formatAmountRaw(BigInt(requiredAmount), 6)} USDC
        </button>
        {error && <p className="text-danger text-sm">{error}</p>}
      </div>
    );
  }

  if (phase === "signing") {
    return (
      <div className="text-center py-8 space-y-3">
        <div className="w-10 h-10 border-2 border-signal border-t-transparent animate-spin mx-auto" />
        <p className="text-ink font-mono text-sm">Confirm in your Solana wallet...</p>
      </div>
    );
  }

  if (phase === "bridging" || phase === "settled" || phase === "error") {
    const mintedOrLater = bridgeStatus ? MINTED_OR_LATER.has(bridgeStatus.state) : false;
    const step1Done = mintedOrLater;
    const step2Done = bridgeStatus?.state === "handoff_to_settlement" || intentStatus === "settled";
    const step3Done = intentStatus === "settled";

    return (
      <div className="space-y-6">
        <p className="text-ink-dim text-xs font-mono">
          Your USDC is moving from Solana to Arc (~15s). You won&apos;t need to sign again.
        </p>

        <ol className="space-y-3 font-mono text-sm border border-border bg-surface p-4">
          <BridgeStep n={1} label="Bridging USDC from Solana" done={step1Done} active={!step1Done} />
          <BridgeStep n={2} label={`Converting to ${intent.settle_currency}`} done={step2Done} active={step1Done && !step2Done} />
          <BridgeStep n={3} label="Settling to recipient" done={step3Done} active={step2Done && !step3Done} />
        </ol>

        {(bridgeStatus?.source_tx_hash || bridgeStatus?.mint_tx_hash) && (
          <div className="border border-border bg-surface p-4 space-y-1">
            {bridgeStatus?.source_tx_hash && (
              <p className="text-ink-dim text-xs font-mono truncate">
                Deposit: {bridgeStatus.source_tx_hash}
              </p>
            )}
            {bridgeStatus?.mint_tx_hash && (
              <p className="text-ink-dim text-xs font-mono truncate">
                Mint: {bridgeStatus.mint_tx_hash}
              </p>
            )}
          </div>
        )}

        {phase === "settled" && (
          <p className="text-signal font-mono">Settled. Thank you.</p>
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
