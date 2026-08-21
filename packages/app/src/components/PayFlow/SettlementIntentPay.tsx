"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { usePublicIntent } from "@/lib/use-public-intent";
import type { Currency } from "@conduit/sdk/lite";
import { currencyDecimals } from "@conduit/sdk/lite";
import { formatAmountRaw, shortenAddress } from "@/lib/format";
import { isoToToken } from "@/lib/currencies";
// Loaded when reached. The cross chain flow is a screen the payer only sees
// after choosing to fund from another chain, and it is one of the largest in
// the app -- shipping it on first paint made every payer pay for a path most
// of them never take. ssr:false: it is wallet driven and renders nothing
// useful on the server.
import { BridgeSkeleton } from "./BridgeSkeleton";
const CrossChainBridge = dynamic(
  () => import("./CrossChainBridge").then((m) => m.CrossChainBridge),
  {
    ssr: false,
    // Draw the shape it is about to be, rather than a gap. Without this the
    // click landed on an empty page for as long as the chunk took to arrive.
    loading: () => <BridgeSkeleton />,
  },
);
import type { BridgeStage } from "./CrossChainBridge";
import { ArcSettlePanel } from "./ArcSettlePanel";
import { usePayerIdentity } from "@/lib/use-payer-identity";
import { usePayerUsdc, routeForAmount } from "@/lib/use-payer-usdc";
import { useBalances } from "@/lib/use-balances";
import { chainLabel } from "@/lib/unified-balance";

interface SettlementIntentPayProps {
  intentId: string;
}

// Payer surface for the B2B settlement_intents API (si_ ids) -- distinct
// from the older on-chain declaration flow this route also serves. If
// source_chain is anything other than "arc", the payer is bridging in via
// CCTP and CrossChainBridge drives the rest of this page.
export function SettlementIntentPay({ intentId }: SettlementIntentPayProps) {
  const [showAddress, setShowAddress] = useState(false);
  // Cross-chain is not a button any more.
  //
  // This surface used to ask "pay with USDC from another chain?" underneath the
  // Pay button, which put a question about plumbing in front of a payer who
  // knows only one thing: which wallet they have. The route now follows from
  // where their USDC actually is -- the same rule /send uses -- and this state
  // exists only so the bridge can be entered once that answer is known.
  const [payFromOtherChain, setPayFromOtherChain] = useState(false);
  // How far the bridge has got. "Paying from Solana" is a statement about what
  // is about to happen, so it belongs only while that is still true -- rendered
  // unconditionally it stayed up through the transfer and ended up sitting
  // directly above the word "Paid", in the present tense, contradicting the
  // receipt's own "Paid from" row two lines below it.
  const [bridgeStage, setBridgeStage] = useState<BridgeStage>("setup");
  const { identity } = usePayerIdentity();
  const sourceUsdc = usePayerUsdc({
    address: identity?.address,
    family: identity?.kind,
    enabled: !!identity,
  });
  const arcBalances = useBalances(identity?.kind === "evm" ? identity.address : undefined);

  // Which chain, if any, this payment has to come from.
  //
  // Null means Arc can cover it and the direct path applies. Arc counts only
  // for an EVM wallet: a Solana wallet cannot sign on Arc at all, so crediting
  // it an Arc balance would offer a route that fails at the signature.
  // Names every chain the payment will draw from, or null when Arc covers it.
  // Plural because a payment can pool across chains now -- "Paying from Base"
  // for a payment that also takes 12 off Polygon would misdescribe it.
  function crossChainFor(amountRaw: bigint): string | null {
    const arcUsdc =
      identity?.kind === "evm" ? (arcBalances.balances.USDC ?? 0n) : 0n;
    const route = routeForAmount(amountRaw, arcUsdc, sourceUsdc.funded);
    if (route.kind !== "cross_chain") return null;
    return route.allocations.map((a) => chainLabel(a.chain)).join(" + ");
  }

  // Shared query with the page's title effect — one request, not two.
  // Keyed by intentId with NO previous-data retention, which is what keeps
  // one invoice's merchant and amount from ever rendering on another's page
  // (the leak this replaced used raw state that survived the id change).
  const { data: fetched, isError } = usePublicIntent(intentId);
  const intent = fetched ?? null;
  const loadError = isError ? "This payment link was not found or has expired." : "";

  if (loadError) {
    return (
      <div className="text-center py-16 space-y-3">
        <p className="text-4xl">⚠</p>
        <p className="text-ink font-medium">{loadError}</p>
        <p className="text-ink-dim text-sm">Ask the business that sent it for a new link.</p>
      </div>
    );
  }

  if (!intent) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 bg-surface" />
        <div className="h-32 bg-surface" />
      </div>
    );
  }

  if (intent.status === "settled") {
    return (
      <div className="text-center py-16 space-y-3">
        <p className="text-signal font-mono text-lg">Settled</p>
        <p className="text-ink-dim text-sm">This payment has already been completed.</p>
      </div>
    );
  }

  // Resolved once the intent is known, so the branch below reads as a fact
  // rather than a computation.
  const crossChain = crossChainFor(BigInt(intent.amount));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        {intent.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={intent.logo_url} alt="" className="w-10 h-10 object-contain border border-border bg-surface" />
        ) : (
          <div className="w-10 h-10 border border-border bg-surface flex items-center justify-center font-display font-bold text-signal">
            {intent.display_name.charAt(0).toUpperCase()}
          </div>
        )}
        <div>
          <p className="text-ink font-medium">{intent.display_name}</p>
          <button
            type="button"
            onClick={() => setShowAddress((v) => !v)}
            className="text-ink-dim text-xs font-mono hover:text-ink"
          >
            {showAddress ? intent.settle_address : shortenAddress(intent.settle_address)}
          </button>
        </div>
      </div>

      {/* The ask, while it is still an ask.
          Same tense problem as the route label: once the bridge lands on its
          receipt this panel was still announcing "REQUESTING 2.5 USDC" above
          the word "Paid", and the receipt's own Amount row printed the same
          number a third time. The merchant header above stays -- who you paid
          is worth having on the receipt; what they wanted is not, once they
          have it. */}
      {bridgeStage !== "done" && (
        <div className="border border-border bg-surface p-4 space-y-1">
          <p className="text-ink-dim text-xs uppercase tracking-wider font-mono">Requesting</p>
          <p className="text-ink font-mono text-2xl">
            {formatAmountRaw(BigInt(intent.amount), currencyDecimals(isoToToken(intent.settle_currency)))}{" "}
            {isoToToken(intent.settle_currency)}
          </p>
        </div>
      )}

      {intent.source_chain !== "arc" || payFromOtherChain ? (
        <>
          <CrossChainBridge intentId={intentId} intent={intent} />
          {intent.source_chain === "arc" && (
            <button
              type="button"
              onClick={() => setPayFromOtherChain(false)}
              className="text-ink-dim text-xs font-mono hover:text-ink"
            >
              ← Pay on Arc instead
            </button>
          )}
        </>
      ) : (
        <>
          {/* The route, decided from where the money is.
              Arc when the balance there covers it; otherwise the richest
              single source chain, entered automatically. A payer is told
              which chain will be spent, and never asked to choose one. */}
          {crossChain ? (
            <>
              {bridgeStage === "setup" && (
                <p className="text-center text-scale-1 font-mono text-signal">
                  Paying from {crossChain}
                </p>
              )}
              <CrossChainBridge
                intentId={intent.id}
                intent={intent}
                knownUsdc={sourceUsdc.unified}
                onStage={setBridgeStage}
              />
            </>
          ) : (
            <ArcSettlePanel
              settleToken={isoToToken(intent.settle_currency) as Currency}
              settleAddress={intent.settle_address}
              amountRaw={BigInt(intent.amount)}
              displayName={intent.display_name}
              // The intent already exists on this surface — just hand back its id.
              ensureIntentId={async () => intent.id}
            />
          )}
        </>
      )}
    </div>
  );
}
