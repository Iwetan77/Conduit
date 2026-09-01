"use client";

import { useHydrated } from "@/lib/use-hydrated";
import { ARC_RPC_URL, arcTestnet } from "@/lib/wagmi";

import { useEffect, useRef, useState } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import type { Currency, PaymentReceipt } from "@conduit/sdk/lite";
import { currencyDecimals } from "@conduit/sdk/lite";
import { formatAmount, formatAmountRaw } from "@/lib/format";
import { PayerCurrencyPicker } from "@/components/SendFlow/PayerCurrencyPicker";
import { RoutePreview } from "@/components/SendFlow/RoutePreview";
import { ReceiptCard } from "@/components/Shared/ReceiptCard";
import { FxReceiptCard } from "@/components/Shared/FxReceiptCard";
import { SaveContactButton } from "@/components/Shared/SaveContactButton";
import { WalletConnectCompact } from "@/components/Shared/WalletConnect";
import { Rocket } from "@/components/Shared/Rocket";

// The single place a payer chooses what to pay with and settles, shared by the
// settlement-intent surface (si_) and the payment-link surface (pl_). Extracted
// so payment links can show the pay-with picker, route preview and Pay button
// on ONE screen instead of a dead "Continue to pay" step followed by the real
// pay screen.
//
// Two genuinely different settlement paths, chosen by whether the payer's
// currency matches what the recipient wants:
//   same-currency  -> on-chain via the SDK (ConduitRouter), sub-second, no FX.
//   cross-currency -> Circle StableFX (quote -> sign -> prepare -> sign ->
//                     confirm), the only working cross-currency route.
//
// `ensureIntentId` is what differs between callers: a settlement intent already
// exists for si_ links (it just returns the id), while a payment link mints one
// at pay time (POST /:id/pay). It's called once and cached, so retrying after a
// failed/expired quote never creates a second intent or re-marks the link paid.
export interface ArcSettlePanelProps {
  // The token actually transferred on Arc (EURC, USDC…). This is also what the
  // Pay button prints: it used to print the merchant's ISO settle_currency
  // instead, so a payer signing for 5 EURC was told they were paying "5 EUR".
  settleToken: Currency;
  settleAddress: string;
  amountRaw: bigint;
  displayName: string;
  ensureIntentId: () => Promise<string>;
  // When set, the Pay button is disabled and shows this text instead — used by
  // open-amount payment links, where the payer must enter a valid amount
  // before the pay-with picker and Pay button mean anything.
  disabledReason?: string;
  // Optional slot rendered above the pay-with picker — payment links put the
  // amount input and reference field here so everything lives on one screen.
  children?: React.ReactNode;
}

export function ArcSettlePanel({
  settleToken,
  settleAddress,
  amountRaw,
  displayName,
  ensureIntentId,
  disabledReason,
  children,
}: ArcSettlePanelProps) {
  const { address, isConnected, connector, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const mounted = useHydrated();
  const [payerCurrency, setPayerCurrency] = useState<Currency>("USDC");
  const [step, setStep] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [receipt, setReceipt] = useState<PaymentReceipt | null>(null);
  const [txError, setTxError] = useState("");
  const [fxStage, setFxStage] = useState("");
  const [fxDone, setFxDone] = useState(false);
  const [fxTx, setFxTx] = useState("");
  const [fxRate, setFxRate] = useState("");
  const [fxPaid, setFxPaid] = useState("");

  // Cache the intent so a retry (expired quote, rejected signature) reuses the
  // same one rather than minting a fresh intent / re-hitting the link's /pay.
  const intentIdRef = useRef<string | null>(null);


  const amountHuman = formatAmountRaw(amountRaw, currencyDecimals(settleToken));

  const handlePay = async () => {
    if (!address) return;
    setStep("pending");
    setTxError("");
    try {
      // Both routes below settle on Arc, so the wallet has to be on Arc first.
      //
      // The page-level ChainGuard deliberately does NOT cover /pay/: paying
      // from another chain is a feature on that page, and gating it would break
      // the cross-chain panel sitting right next to this one. So the check
      // belongs here, at the only point that actually requires Arc.
      //
      // Without it the send failed inside the wallet and classifyTxError read
      // that as "Couldn't reach the network. Check your connection" -- a
      // connectivity message for a wallet that is simply on Ethereum, which
      // sends the payer to look at their wifi. A payer is a stranger: they do
      // not report it, they leave.
      //
      // Offers the switch rather than only complaining, since the wallet can
      // usually just move.
      if (chainId !== undefined && chainId !== arcTestnet.id) {
        try {
          await switchChainAsync({ chainId: arcTestnet.id });
        } catch {
          setStep("idle");
          setTxError(
            `Your wallet is on another network. Switch it to Arc Testnet to pay, ` +
            `or choose "Pay with USDC on another chain".`
          );
          return;
        }
      }
      if (payerCurrency === settleToken) {
        // Same currency: mark the underlying intent (creating it for a link),
        // then settle straight on-chain to the recipient. No FX.
        setFxStage("Settling on-chain…");
        if (!intentIdRef.current) intentIdRef.current = await ensureIntentId();
        const { ConduitClient } = await import("@conduit/sdk");
        const { ethers } = await import("ethers");
        const { browserProviderFor } = await import("@/lib/wallet-provider");
        const browserProvider = await browserProviderFor(connector);
        const client = ConduitClient.fromBrowserProvider(browserProvider, "", undefined, ARC_RPC_URL);
        const result = await client.pay({
          recipient: settleAddress as `0x${string}`,
          amount: amountRaw,
          currency: settleToken,
          payerToken: payerCurrency,
        });
        setReceipt(result);
        setStep("success");
        // Same-currency pays settle on-chain in this browser with no server
        // step, so the intent would otherwise stay "created" forever. Report
        // the tx so the server verifies it on Arc, marks the intent settled and
        // fires the settlement.succeeded webhook — this is what flips a gateway
        // checkout to "payment received". Best-effort for the payer's own UI
        // (they've already paid), but it's the merchant's only settlement
        // signal, so a failure is surfaced in the console rather than swallowed.
        if (intentIdRef.current) {
          try {
            const { recordDirectSettlement } = await import("@/lib/conduit-api");
            await recordDirectSettlement(intentIdRef.current, result.txHash);
          } catch (recErr) {
            console.error("Failed to record settlement with Conduit:", recErr);
          }
          const { emitCheckoutSettled } = await import("@/lib/checkout-events");
          emitCheckoutSettled(intentIdRef.current);
        }
        return;
      }

      // Cross-currency: Circle StableFX via the API. Real, stage-by-stage
      // progress — two wallet signatures, never a timed animation.
      if (!intentIdRef.current) intentIdRef.current = await ensureIntentId();
      const { runFxCheckout } = await import("@/lib/fx-checkout");
      const res = await runFxCheckout(intentIdRef.current, payerCurrency, setFxStage, connector);
      setFxTx(res.txHash);
      setFxRate(res.rate);
      setFxPaid(formatAmountRaw(BigInt(res.payAmount), currencyDecimals(payerCurrency)));
      setFxDone(true);
      setStep("success");
      if (intentIdRef.current) {
        const { emitCheckoutSettled } = await import("@/lib/checkout-events");
        emitCheckoutSettled(intentIdRef.current);
      }
    } catch (err) {
      const { formatTxError } = await import("@/lib/tx-errors");
      setTxError(formatTxError(err));
      setStep("error");
    }
  };

  // The amount a payer is being asked for must never be invisible.
  //
  // This was a bare null return on the hydration gate, which blanked the ENTIRE
  // pay panel on
  // the first paint of the checkout page -- the one screen in the product where
  // someone is deciding whether to part with money. `children` is the amount box
  // and the reference field: static, wallet-independent, and safe to render
  // immediately. Only the parts that genuinely depend on a wallet wait, and they
  // wait as boxes of the right size rather than as absence, so nothing moves
  // when they arrive.
  if (!mounted) {
    return (
      <div className="space-y-4" aria-busy="true">
        {children}
        <div className="h-[58px] border border-border bg-surface animate-pulse" aria-hidden />
        <div className="h-[64px] border border-border bg-surface animate-pulse" aria-hidden />
        <div className="h-[60px] bg-surface animate-pulse" aria-hidden />
      </div>
    );
  }

  if (step === "success" && receipt) {
    return (
      <div className="space-y-3">
        <ReceiptCard receipt={receipt} />
        <p className="text-ink-dim text-xs font-mono text-center">
          Paid to {displayName}. You can close this page.
        </p>
        {/* Offered here because this is the moment it is worth nothing to
            accept: they have just confirmed who this is by paying them. */}
        <SaveContactButton address={settleAddress} label={displayName} />
      </div>
    );
  }

  if (step === "success" && fxDone) {
    return (
      <div className="space-y-3">
        <FxReceiptCard
          payAmount={fxPaid}
          receiveAmount={formatAmount(amountRaw, settleToken)}
          receiveCurrency={settleToken}
          recipient={displayName}
          rate={fxRate}
          txHash={fxTx}
        />
        <p className="text-ink-dim text-xs font-mono text-center">
          Paid to {displayName}. You can close this page.
        </p>
        {/* Offered here because this is the moment it is worth nothing to
            accept: they have just confirmed who this is by paying them. */}
        <SaveContactButton address={settleAddress} label={displayName} />
      </div>
    );
  }

  if (step === "pending") {
    return (
      <div className="text-center py-10 space-y-4">
        <Rocket size={64} />
        <p className="text-ink font-mono text-sm">{fxStage || "Settling on-chain…"}</p>
        {payerCurrency !== settleToken && (
          <p className="text-ink-dim text-xs font-mono max-w-xs mx-auto">
            Cross-currency payments take longer than a direct transfer and need
            two wallet signatures.
          </p>
        )}
      </div>
    );
  }

  if (!isConnected) {
    return (
      <div className="space-y-4">
        {children}
        <p className="text-ink-dim text-sm text-center">Connect a wallet to pay</p>
        <WalletConnectCompact />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {children}
      <PayerCurrencyPicker value={payerCurrency} onChange={setPayerCurrency} />
      <RoutePreview
        payerCurrency={payerCurrency}
        recipientCurrency={settleToken}
        recipientAmount={amountHuman}
        recipientAmountRaw={amountRaw}
      />
      {step === "error" && (
        <div className="bg-danger/10 border border-danger/30 p-3">
          <p className="text-danger text-sm font-mono">{txError}</p>
        </div>
      )}
      <button
        onClick={handlePay}
        disabled={!!disabledReason}
        className="w-full py-4 bg-signal text-signal-ink font-mono text-lg
                   hover:bg-signal/90 transition-colors disabled:opacity-50 disabled:hover:bg-signal"
      >
        {disabledReason ?? `Pay ${amountHuman} ${settleToken}`}
      </button>
    </div>
  );
}
