"use client";

import { ARC_RPC_URL } from "@/lib/wagmi";

import { useState } from "react";
import { useAccount } from "wagmi";
import type { Currency, PaymentReceipt } from "@conduit/sdk/lite";
import { parseAmount, formatAmount, shortenAddress } from "@/lib/format";
import { RoutePreview } from "./RoutePreview";
import { ReceiptCard } from "@/components/Shared/ReceiptCard";
import { FxReceiptCard } from "@/components/Shared/FxReceiptCard";
import { StepProgress } from "@/components/Shared/StepProgress";
import { CrossChainBridge } from "@/components/PayFlow/CrossChainBridge";
import type { PublicSettlementIntent } from "@/lib/conduit-api";
import { motion, AnimatePresence } from "framer-motion";

interface SendConfirmProps {
  recipient: string;
  amount: string;
  recipientCurrency: Currency;
  payerCurrency: Currency;
  onBack: () => void;
  onReset: () => void;
}

export function SendConfirm({
  recipient,
  amount,
  recipientCurrency,
  payerCurrency,
  onBack,
  onReset,
}: SendConfirmProps) {
  const { address, connector } = useAccount();
  const [step, setStep] = useState<"confirm" | "pending" | "success" | "error">("confirm");
  const [receipt, setReceipt] = useState<PaymentReceipt | null>(null);
  const [error, setError] = useState<string>("");
  const [fxStage, setFxStage] = useState("");
  const [fxDone, setFxDone] = useState(false);
  const [fxTx, setFxTx] = useState("");
  const [fxRate, setFxRate] = useState("");
  const [fxPaid, setFxPaid] = useState("");
  // Cross-CHAIN funding from /send: the payer holds their USDC on Solana (or
  // another Gateway chain) rather than on Arc. Same machinery the payment-link
  // checkout uses -- a direct settlement intent plus CrossChainBridge -- so
  // /send is no longer Arc-only for funding.
  const [bridgeIntent, setBridgeIntent] = useState<PublicSettlementIntent | null>(null);
  const [bridgeBusy, setBridgeBusy] = useState(false);

  const startCrossChain = async () => {
    if (!address) return;
    setBridgeBusy(true);
    setError("");
    try {
      const { createDirectSettlementIntent, getPublicSettlementIntent } = await import("@/lib/conduit-api");
      const intent = await createDirectSettlementIntent({
        payer_wallet: address,
        amount: parsedAmount.toString(),
        settle_currency: recipientCurrency,
        settle_address: recipient,
        accept_currencies: [payerCurrency],
      });
      setBridgeIntent(await getPublicSettlementIntent(intent.id));
    } catch (err) {
      const { formatTxError } = await import("@/lib/tx-errors");
      setError(formatTxError(err));
    } finally {
      setBridgeBusy(false);
    }
  };

  const parsedAmount = parseAmount(amount, recipientCurrency);
  const isCrossCurrency = payerCurrency !== recipientCurrency;

  const handleSend = async () => {
    if (!address) return;
    setStep("pending");

    try {
      if (isCrossCurrency) {
        // Cross-currency needs a settlement intent for StableFX to price and
        // deliver against. A connected wallet is the only requirement — the
        // server provisions a wallet-keyed personal account to own the intent.
        // No sign-in, no merchant onboarding, no dashboard.
        const { createDirectSettlementIntent } = await import("@/lib/conduit-api");

        setFxStage("Preparing the payment…");
        const intent = await createDirectSettlementIntent({
          payer_wallet: address,
          amount: parsedAmount.toString(),
          settle_currency: recipientCurrency,
          settle_address: recipient,
          accept_currencies: [payerCurrency],
        });

        const { runFxCheckout } = await import("@/lib/fx-checkout");
        const res = await runFxCheckout(intent.id, payerCurrency, setFxStage, connector);
        setFxTx(res.txHash);
        setFxRate(res.rate);
        setFxPaid(formatAmount(BigInt(res.payAmount), payerCurrency));
        setFxDone(true);
        setStep("success");
        return;
      }

      // Dynamic import to avoid SSR issues
      const { ConduitClient } = await import("@conduit/sdk");
      const { ethers } = await import("ethers");
      const { getWalletProvider } = await import("@/lib/wallet-provider");

      // The connected wallet, via wagmi's connector — NOT window.ethereum,
      // which is absent for Privy embedded wallets and ambiguous when more
      // than one extension is installed.
      const browserProvider = new ethers.BrowserProvider(await getWalletProvider(connector));
      const client = ConduitClient.fromBrowserProvider(browserProvider, "", undefined, ARC_RPC_URL);

      const result = await client.pay({
        recipient: recipient as `0x${string}`,
        amount: parsedAmount,
        currency: recipientCurrency,
        payerToken: payerCurrency,
      });

      setReceipt(result);
      setStep("success");
    } catch (err) {
      const { formatTxError } = await import("@/lib/tx-errors");
      setError(formatTxError(err));
      setStep("error");
    }
  };

  return (
    <div className="space-y-6">
      <StepProgress
        steps={["Enter details", "Confirm", "Done"]}
        current={step === "confirm" ? 1 : step === "pending" ? 1 : 2}
      />

      <AnimatePresence mode="wait">
        {/* Cross-chain funding takes over the whole surface once started: it
            has its own connect / balance / confirm / bridging states. */}
        {bridgeIntent && (
          <motion.div key="bridge" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
            <CrossChainBridge intentId={bridgeIntent.id} intent={bridgeIntent} />
            <button
              onClick={() => setBridgeIntent(null)}
              className="w-full py-3 border border-border text-ink-dim hover:text-ink transition-colors font-mono text-sm"
            >
              ← Pay from Arc instead
            </button>
          </motion.div>
        )}

        {!bridgeIntent && step === "confirm" && (
          <motion.div
            key="confirm"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            className="space-y-4"
          >
            <div className="bg-surface border border-border p-5 space-y-4">
              <h3 className="text-sm font-mono text-ink-dim uppercase tracking-wider">
                Confirm Payment
              </h3>

              <div className="space-y-3">
                <Row label="To" value={shortenAddress(recipient)} mono />
                <Row
                  label="Amount"
                  value={formatAmount(parsedAmount, recipientCurrency)}
                />
              </div>
            </div>

            <RoutePreview
              payerCurrency={payerCurrency}
              recipientCurrency={recipientCurrency}
              recipientAmount={amount}
            />

            {/* Fund this send from another chain — same flow the payment-link
                checkout offers, so a payer holding USDC on Solana can pay an
                Arc recipient straight from /send. */}
            <button
              type="button"
              onClick={startCrossChain}
              disabled={bridgeBusy}
              className="w-full flex flex-col items-center gap-1 py-3.5 px-4 border border-signal/40 bg-signal/5
                         hover:bg-signal/10 hover:border-signal/60 transition-colors disabled:opacity-50"
            >
              <span className="flex items-center gap-2 text-signal font-mono text-sm">
                <span aria-hidden className="text-base leading-none">⇄</span>
                {bridgeBusy ? "Preparing…" : "Pay with USDC from another chain"}
              </span>
              <span className="text-ink-dim text-[11px] font-mono tracking-wide">
                Solana · Base · Polygon
              </span>
            </button>

            <div className="flex gap-3">
              <button
                onClick={onBack}
                className="flex-1 py-3 border border-border
                           text-ink-dim hover:text-ink hover:border-ink-dim/20
                           transition-colors font-mono"
              >
                Back
              </button>
              <button
                onClick={handleSend}
                className="flex-1 py-3 bg-signal text-signal-ink
                           font-mono hover:bg-signal/90 transition-colors"
              >
                Send Payment
              </button>
            </div>
          </motion.div>
        )}

        {step === "pending" && (
          <motion.div
            key="pending"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center py-16 space-y-4"
          >
            <div className="w-16 h-16 border-2 border-signal border-t-transparent
                            animate-spin mx-auto" />
            <p className="text-ink font-mono">
              {isCrossCurrency ? fxStage || "Preparing the payment…" : "Settling on-chain..."}
            </p>
            <p className="text-ink-dim text-sm font-mono max-w-xs mx-auto">
              {isCrossCurrency
                ? "Cross-currency routes through Circle StableFX and needs two wallet signatures."
                : "Arc finalizes in under a second"}
            </p>
          </motion.div>
        )}

        {step === "success" && fxDone && (
          <motion.div
            key="fx-success"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-4"
          >
            <FxReceiptCard
              payAmount={fxPaid}
              receiveAmount={formatAmount(parsedAmount, recipientCurrency)}
              receiveCurrency={recipientCurrency}
              recipient={recipient}
              rate={fxRate}
              txHash={fxTx}
            />
            <button
              onClick={onReset}
              className="w-full py-3 border border-border
                         text-ink hover:border-signal/30 transition-colors font-mono"
            >
              Send Another
            </button>
          </motion.div>
        )}

        {step === "success" && receipt && (
          <motion.div
            key="success"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-4"
          >
            <ReceiptCard receipt={receipt} />
            <button
              onClick={onReset}
              className="w-full py-3 border border-border
                         text-ink hover:border-signal/30 transition-colors font-mono"
            >
              Send Another
            </button>
          </motion.div>
        )}

        {step === "error" && (
          <motion.div
            key="error"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-4"
          >
            <div className="bg-danger/10 border border-danger/30 p-5">
              <p className="text-danger font-mono mb-2">Transaction Failed</p>
              <p className="text-danger/70 text-sm font-mono">{error}</p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setStep("confirm")}
                className="flex-1 py-3 border border-border
                           text-ink hover:border-ink-dim/20 transition-colors"
              >
                Try Again
              </button>
              <button
                onClick={onReset}
                className="flex-1 py-3 bg-surface border border-border
                           text-ink-dim hover:text-ink transition-colors"
              >
                Start Over
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-ink-dim text-sm">{label}</span>
      <span className={`text-ink text-sm ${mono ? "font-mono" : "font-medium"}`}>
        {value}
      </span>
    </div>
  );
}
