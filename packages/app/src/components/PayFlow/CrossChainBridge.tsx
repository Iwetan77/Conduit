"use client";

// Cross-chain (CCTP) bridge flow for a payer funding a settlement intent
// from Solana USDC. This is NOT atomic and never described as such anywhere
// in this file: it's an honest burn -> attestation -> mint -> settle
// sequence, ~8-30s on Fast Transfer (see internal/bridge/README.md). The
// payer signs exactly once, on Solana; everything after that is polled
// server state, not client-driven animation.
import { useEffect, useRef, useState } from "react";
import {
  connectSolanaWallet,
  getSolanaProvider,
  signAndSubmitBurn,
} from "@/lib/solana-wallet";
import {
  initiateBridge,
  reportBridgeBurn,
  getBridgeStatus,
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

type Phase = "connect" | "amount" | "signing" | "bridging" | "settled" | "error";

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
  const [usdcAmount, setUsdcAmount] = useState(intent.amount);
  const [transferId, setTransferId] = useState<string | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus | null>(null);
  const [intentStatus, setIntentStatus] = useState(intent.status);
  const [error, setError] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const hasPhantom = typeof window !== "undefined" && !!getSolanaProvider();

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Orphan-safe: if a bridge for this intent is already in flight (payer
  // reopened the tab after closing it mid-bridge), pick up polling
  // immediately instead of showing the connect/amount screen again.
  useEffect(() => {
    getBridgeStatus(intentId)
      .then((status) => {
        setBridgeStatus(status);
        setTransferId(status.transfer_id);
        if (status.state !== "failed") {
          setPhase("bridging");
          startPolling(status.transfer_id);
        }
      })
      .catch(() => {
        // No transfer yet -- expected for a fresh payment link.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentId]);

  function startPolling(_transferId: string) {
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

  async function handleConnect() {
    setError("");
    try {
      const addr = await connectSolanaWallet();
      setPayerAddress(addr);
      setPhase("amount");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect Solana wallet");
    }
  }

  async function handleBridge() {
    if (!payerAddress) return;
    setError("");
    setPhase("signing");
    try {
      const init = await initiateBridge(intentId, payerAddress, usdcAmount);
      if (!init.unsigned_tx_base64) throw new Error("No burn transaction returned");
      setTransferId(init.transfer_id);

      const burnSignature = await signAndSubmitBurn(init.unsigned_tx_base64);
      await reportBridgeBurn(intentId, init.transfer_id, burnSignature);

      setPhase("bridging");
      startPolling(init.transfer_id);
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

  if (phase === "amount") {
    return (
      <div className="space-y-4">
        <p className="text-ink-dim text-sm">
          Connected: <span className="text-ink font-mono">{payerAddress}</span>
        </p>
        <label className="block space-y-1">
          <span className="text-ink-dim text-xs uppercase tracking-wider font-mono">
            USDC to send from Solana (minor units)
          </span>
          <input
            value={usdcAmount}
            onChange={(e) => setUsdcAmount(e.target.value)}
            className="w-full bg-surface border border-border px-3 py-2 font-mono text-ink"
          />
        </label>
        <p className="text-ink-dim text-xs">
          Your USDC moves from Solana to Arc first (~15s), then converts to{" "}
          {intent.settle_currency} and settles. You won&apos;t need to sign again.
        </p>
        <button
          onClick={handleBridge}
          className="w-full py-4 bg-signal text-signal-ink font-mono text-lg hover:bg-signal/90 transition-colors"
        >
          Bridge {formatAmountRaw(BigInt(usdcAmount || "0"), 6)} USDC
        </button>
        {error && <p className="text-danger text-sm">{error}</p>}
      </div>
    );
  }

  if (phase === "signing") {
    return (
      <div className="text-center py-8 space-y-3">
        <div className="w-10 h-10 border-2 border-signal border-t-transparent animate-spin mx-auto" />
        <p className="text-ink font-mono text-sm">Confirm the burn in your Solana wallet...</p>
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

        <ol className="space-y-3 font-mono text-sm">
          <BridgeStep n={1} label="Bridging USDC from Solana" done={step1Done} active={!step1Done} />
          <BridgeStep n={2} label={`Converting to ${intent.settle_currency}`} done={step2Done} active={step1Done && !step2Done} />
          <BridgeStep n={3} label="Settling to recipient" done={step3Done} active={step2Done && !step3Done} />
        </ol>

        {bridgeStatus?.source_tx_hash && (
          <p className="text-ink-dim text-xs font-mono truncate">
            Burn: {bridgeStatus.source_tx_hash}
          </p>
        )}
        {bridgeStatus?.mint_tx_hash && (
          <p className="text-ink-dim text-xs font-mono truncate">
            Mint: {bridgeStatus.mint_tx_hash}
          </p>
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
