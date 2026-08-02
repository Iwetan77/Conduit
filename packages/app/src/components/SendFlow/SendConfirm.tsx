"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { requestGoogleLogin } from "@/lib/privy-gate";
import type { Currency, PaymentReceipt } from "@conduit/sdk/lite";
import { parseAmount, formatAmount, shortenAddress } from "@/lib/format";
import { RoutePreview } from "./RoutePreview";
import { ReceiptCard } from "@/components/Shared/ReceiptCard";
import { StepProgress } from "@/components/Shared/StepProgress";
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

  const parsedAmount = parseAmount(amount, recipientCurrency);
  const isCrossCurrency = payerCurrency !== recipientCurrency;

  const handleSend = async () => {
    if (!address) return;
    setStep("pending");

    try {
      if (isCrossCurrency) {
        // Cross-currency needs a settlement intent to hang the StableFX trade
        // on, and creating one is an authenticated call — so a direct send in
        // a different currency requires being signed in. The payer still
        // signs both FX payloads with their own wallet.
        const { createSettlementIntent, getSessionToken, createAccountFromPrivy } =
          await import("@/lib/conduit-api");

        if (!getSessionToken()) {
          throw new Error("SIGN_IN_REQUIRED");
        }

        setFxStage("Preparing the payment…");
        // Direct send provisions its OWN personal account, silently. It never
        // routes through merchant onboarding: no business name prompt, no
        // dashboard. The account is just the owner record a settlement intent
        // needs (account_id is a required FK).
        //
        // `name` is mandatory server-side — omitting it was returning
        // "name, settle_currency, login_wallet are required", which read to
        // the user as being told to go create a merchant account.
        try {
          const token = getSessionToken();
          if (token && address) {
            await createAccountFromPrivy(token, {
              name: `Personal ${address.slice(0, 6)}…${address.slice(-4)}`,
              login_wallet: address,
              settle_currency: recipientCurrency,
              settle_address: address,
            });
          }
        } catch {
          // Already onboarded — the handler returns the existing account.
        }

        const intent = await createSettlementIntent({
          amount: parsedAmount.toString(),
          settle_currency: recipientCurrency,
          settle_address: recipient,
          accept_currencies: [payerCurrency],
        });

        const { runFxCheckout } = await import("@/lib/fx-checkout");
        const res = await runFxCheckout(intent.id, payerCurrency, setFxStage, connector);
        setFxTx(res.txHash);
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
      const client = ConduitClient.fromBrowserProvider(browserProvider, "");

      const result = await client.pay({
        recipient: recipient as `0x${string}`,
        amount: parsedAmount,
        currency: recipientCurrency,
        payerToken: payerCurrency,
      });

      setReceipt(result);
      setStep("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transaction failed");
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
        {step === "confirm" && (
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
            <div className="border border-signal/40 bg-signal/5 p-5 text-center space-y-2">
              <p className="text-signal font-mono text-sm">
                Sent {amount} {recipientCurrency} to {shortenAddress(recipient)}
              </p>
              <p className="text-ink-dim text-xs font-mono">
                Converted from {payerCurrency} via Circle StableFX.
              </p>
              {fxTx && (
                <a
                  href={`https://testnet.arcscan.app/tx/${fxTx}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block text-signal text-xs font-mono hover:underline break-all"
                >
                  {fxTx}
                </a>
              )}
            </div>
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
            {error === "SIGN_IN_REQUIRED" ? (
              <div className="border border-border bg-surface p-5 space-y-3 text-center">
                <p className="text-ink font-mono text-sm">Sign in to send across currencies</p>
                <p className="text-ink-dim text-xs font-mono">
                  Circle StableFX has to attach the trade to an identity. This is a
                  personal sign-in, not a merchant account — no business details, no
                  dashboard. Same-currency sends skip it entirely.
                </p>
                <button
                  onClick={() => {
                    requestGoogleLogin();
                    setStep("confirm");
                  }}
                  className="w-full py-2.5 bg-signal text-signal-ink font-mono text-sm
                             hover:bg-signal/90 transition-colors"
                >
                  Sign in with Google
                </button>
              </div>
            ) : (
              <div className="bg-danger/10 border border-danger/30 p-5">
                <p className="text-danger font-mono mb-2">Transaction Failed</p>
                <p className="text-danger/70 text-sm font-mono">{error}</p>
              </div>
            )}
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
