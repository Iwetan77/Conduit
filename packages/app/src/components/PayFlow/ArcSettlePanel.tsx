"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import type { Currency, PaymentReceipt } from "@conduit/sdk/lite";
import { currencyDecimals } from "@conduit/sdk/lite";
import { formatAmount, formatAmountRaw } from "@/lib/format";
import { PayerCurrencyPicker } from "@/components/SendFlow/PayerCurrencyPicker";
import { RoutePreview } from "@/components/SendFlow/RoutePreview";
import { ReceiptCard } from "@/components/Shared/ReceiptCard";
import { FxReceiptCard } from "@/components/Shared/FxReceiptCard";
import { WalletConnectCompact } from "@/components/Shared/WalletConnect";

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
  settleToken: Currency;
  settleCurrencyIso: string;
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
  settleCurrencyIso,
  settleAddress,
  amountRaw,
  displayName,
  ensureIntentId,
  disabledReason,
  children,
}: ArcSettlePanelProps) {
  const { address, isConnected, connector } = useAccount();
  const [mounted, setMounted] = useState(false);
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

  useEffect(() => { setMounted(true); }, []);

  const amountHuman = formatAmountRaw(amountRaw, currencyDecimals(settleToken));

  const handlePay = async () => {
    if (!address) return;
    setStep("pending");
    setTxError("");
    try {
      if (payerCurrency === settleToken) {
        // Same currency: mark the underlying intent (creating it for a link),
        // then settle straight on-chain to the recipient. No FX.
        setFxStage("Settling on-chain…");
        if (!intentIdRef.current) intentIdRef.current = await ensureIntentId();
        const { ConduitClient } = await import("@conduit/sdk");
        const { ethers } = await import("ethers");
        const { getWalletProvider } = await import("@/lib/wallet-provider");
        const browserProvider = new ethers.BrowserProvider(await getWalletProvider(connector));
        const client = ConduitClient.fromBrowserProvider(browserProvider, "");
        const result = await client.pay({
          recipient: settleAddress as `0x${string}`,
          amount: amountRaw,
          currency: settleToken,
          payerToken: payerCurrency,
        });
        setReceipt(result);
        setStep("success");
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
    } catch (err) {
      setTxError(err instanceof Error ? err.message : "Transaction failed");
      setStep("error");
    }
  };

  if (!mounted) return null;

  if (step === "success" && receipt) {
    return (
      <div className="space-y-3">
        <ReceiptCard receipt={receipt} />
        <p className="text-ink-dim text-xs font-mono text-center">
          Paid to {displayName}. You can close this page.
        </p>
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
      </div>
    );
  }

  if (step === "pending") {
    return (
      <div className="text-center py-10 space-y-4">
        <div className="w-12 h-12 border-2 border-signal border-t-transparent animate-spin mx-auto" />
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
        {disabledReason ?? `Pay ${amountHuman} ${settleCurrencyIso}`}
      </button>
    </div>
  );
}
