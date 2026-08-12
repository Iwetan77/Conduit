"use client";

import Link from "next/link";

import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import { isAddress } from "viem";
import { Nav, MobileNav } from "@/components/Shared/Nav";
import { AddressInput } from "@/components/SendFlow/AddressInput";
import { AmountInput } from "@/components/SendFlow/AmountInput";
import { RoutePreview } from "@/components/SendFlow/RoutePreview";
import { SendConfirm } from "@/components/SendFlow/SendConfirm";
import { CrossChainBridge } from "@/components/PayFlow/CrossChainBridge";
import type { PublicSettlementIntent } from "@/lib/conduit-api";
import { PayerCurrencyPicker } from "@/components/SendFlow/PayerCurrencyPicker";
import { WalletConnect } from "@/components/Shared/WalletConnect";
import { ScanToPay } from "@/components/PayFlow/ScanToPay";
import type { Currency } from "@conduit/sdk/lite";
import { motion, AnimatePresence } from "framer-motion";
import { useRequiredPayerAmount } from "@/lib/use-required-payer-amount";
import { formatAmount, tryParseAmount } from "@/lib/format";
import type { BalanceMap } from "@/lib/use-balances";

type Step = "input" | "confirm";

// The real send flow, on its own route. The landing page at / shows a
// scripted demo of this instead, so a first-time visitor sees how it works
// without a wallet, and only lands here once they've chosen to pay.
export default function SendPage() {
  const [mounted, setMounted] = useState(false);
  const { isConnected } = useAccount();
  const [step, setStep] = useState<Step>("input");

  useEffect(() => { setMounted(true); }, []);

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [recipientCurrency, setRecipientCurrency] = useState<Currency>("USDC");
  const [payerCurrency, setPayerCurrency] = useState<Currency>("USDC");
  const [payerBalances, setPayerBalances] = useState<BalanceMap>({});
  // Cross-CHAIN funding lives on THIS step, not the confirm step, and is not
  // gated on isConnected. Someone whose USDC is on Solana has no Arc/EVM
  // wallet at all -- putting this behind "Connect your wallet to send" made the
  // one path built for them reachable only by first connecting the exact wallet
  // they don't have.
  const [bridgeIntent, setBridgeIntent] = useState<PublicSettlementIntent | null>(null);
  const [bridgeBusy, setBridgeBusy] = useState(false);
  const [bridgeError, setBridgeError] = useState("");

  const startCrossChain = async () => {
    // Validate on CLICK, never by disabling the button. A greyed-out control
    // with no affordance reads as broken -- especially here, where this is the
    // only path a payer without an Arc wallet can use, so "it does nothing" is
    // a dead end rather than a hint.
    if (!isAddress(recipient)) {
      setBridgeError("Enter the recipient's Arc address above first.");
      return;
    }
    if (!(parseFloat(amount) > 0)) {
      setBridgeError("Enter an amount above first.");
      return;
    }
    setBridgeBusy(true);
    setBridgeError("");
    try {
      const { createDirectSettlementIntent, getPublicSettlementIntent } = await import("@/lib/conduit-api");
      const { parseAmount: pa } = await import("@/lib/format");
      const intent = await createDirectSettlementIntent({
        // No EVM wallet is connected on this path, so the intent is keyed by the
        // recipient -- personalAccountForWallet treats it as an opaque owner id,
        // and settle_address is what actually decides the payout.
        payer_wallet: recipient,
        amount: pa(amount, recipientCurrency).toString(),
        settle_currency: recipientCurrency,
        settle_address: recipient,
        accept_currencies: ["USDC"],
      });
      setBridgeIntent(await getPublicSettlementIntent(intent.id));
    } catch (err) {
      const { formatTxError } = await import("@/lib/tx-errors");
      setBridgeError(formatTxError(err));
    } finally {
      setBridgeBusy(false);
    }
  };

  // What this send actually costs in the payer's currency (AMM exact-out
  // quote for cross-currency, 1:1 for same), checked against their real
  // balance BEFORE the confirm step so nobody walks into a revert.
  const required = useRequiredPayerAmount(payerCurrency, recipientCurrency, amount);
  const payerBalance = payerBalances[payerCurrency];
  const insufficient =
    required.data !== undefined && payerBalance !== undefined && payerBalance < required.data;

  // Cross-currency is a first-class send, not a merchant-only feature: it
  // settles through Circle StableFX against a settlement intent that /send
  // creates against its own personal account. No payment link, no merchant
  // dashboard. SendConfirm drives it end to end.
  const crossCurrency = payerCurrency !== recipientCurrency;
  const canProceed =
    isAddress(recipient) &&
    parseFloat(amount) > 0 &&
    isConnected &&
    !insufficient;

  return (
    <div className="min-h-screen">
      <Nav />

      <main className="max-w-lg mx-auto px-4 pt-24 pb-24">
        <div className="text-center mb-8">
          <h1 className="font-display font-bold text-3xl text-ink">Send</h1>
          <p className="text-ink-dim text-sm mt-1">
            Pay anyone in the currency they want, from whatever you hold.
          </p>
          <div className="flex justify-center mt-5">
            {/* A storefront QR encodes a bare wallet address (see the
                Storefronts dashboard page), not a /pay/ link -- there's no
                settlement intent to navigate to, so scanning one fills the
                recipient field right here instead. */}
            <ScanToPay onAddress={setRecipient} />
          </div>
        </div>

        <AnimatePresence mode="wait">
          {bridgeIntent && (
            <div className="space-y-4">
              <CrossChainBridge intentId={bridgeIntent.id} intent={bridgeIntent} />
              <button
                onClick={() => setBridgeIntent(null)}
                className="w-full py-3 border border-border text-ink-dim hover:text-ink
                           transition-colors font-mono text-sm"
              >
                ← Back
              </button>
            </div>
          )}

          {!bridgeIntent && step === "input" && (
            <motion.div
              key="input"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              className="space-y-6"
            >
              <div className="bg-surface border border-border p-6 space-y-6">
                <h2 className="text-xs font-mono text-ink-dim uppercase tracking-widest">
                  Direct Send
                </h2>

                <AddressInput value={recipient} onChange={setRecipient} />

                <AmountInput
                  value={amount}
                  onChange={setAmount}
                  currency={recipientCurrency}
                  onCurrencyChange={(c) => setRecipientCurrency(c)}
                  label="They receive"
                />

                {/* Balance-aware: only what this wallet actually holds on Arc.
                    Meaningless without a connected Arc wallet -- a payer whose
                    USDC is on Solana would just see an empty picker and assume
                    the form was broken. */}
                {mounted && isConnected && (
                  <PayerCurrencyPicker
                    value={payerCurrency}
                    onChange={setPayerCurrency}
                    onBalancesChange={setPayerBalances}
                  />
                )}

                {crossCurrency && (
                  <div className="border border-border bg-surface p-3 space-y-1">
                    <p className="text-ink text-sm font-mono">
                      Converting {payerCurrency} → {recipientCurrency}
                    </p>
                    <p className="text-ink-dim text-sm">
                      Circle StableFX prices this at payment time. You&apos;ll see the exact
                      rate and what it costs you before you sign anything.
                    </p>
                  </div>
                )}

                {/* Applies to every pair now, not just same-currency. A payer
                    short on EURC for a USDC payment used to sail past this and
                    fail at the wallet prompt, after an intent had been created.
                    formatAmount already appends the currency — naming it again
                    printed "~$50.00 USDC USDC". */}
                {insufficient && required.data !== undefined && payerBalance !== undefined && (
                  <p className="text-danger text-sm font-mono">
                    Insufficient {payerCurrency}: this payment needs ~
                    {formatAmount(required.data, payerCurrency)}, you have{" "}
                    {formatAmount(payerBalance, payerCurrency)}.
                  </p>
                )}

                {amount && recipient && (
                  <RoutePreview
                    payerCurrency={payerCurrency}
                    recipientCurrency={recipientCurrency}
                    recipientAmount={amount}
                    payerAmount={
                      // Same-currency is known exactly. Cross-currency is left
                      // undefined on purpose: RoutePreview now fetches a live
                      // indicative rate for it (GET /v1/fx/rates) and shows
                      // what you'd actually send, instead of the blank it used
                      // to leave until the wallet prompt.
                      payerCurrency === recipientCurrency && required.data !== undefined
                        ? formatAmount(required.data, payerCurrency)
                        : undefined
                    }
                    recipientAmountRaw={tryParseAmount(amount, recipientCurrency)}
                    isLoading={required.isLoading}
                  />
                )}
              </div>

              {!mounted || !isConnected ? (
                <div className="text-center space-y-3">
                  <p className="text-ink-dim text-sm">
                    Connect a wallet to pay from Arc
                  </p>
                  <div className="flex justify-center">
                    <WalletConnect />
                  </div>
                  {/* Reads as "one of two ways", not "the requirement". Without
                      this the prompt above looked mandatory, so a Solana payer
                      stopped here -- at a wallet they don't have -- instead of
                      using the cross-chain option right below. */}
                  <p className="text-ink-dim text-xs font-mono pt-1">
                    — or —
                  </p>
                </div>
              ) : (
                <button
                  onClick={() => setStep("confirm")}
                  disabled={!canProceed}
                  className="w-full py-4 bg-signal text-signal-ink
                             font-mono text-xl hover:bg-signal/90 transition-colors
                             disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Review Payment →
                </button>
              )}

              {/* Deliberately OUTSIDE the isConnected gate: this is the path for
                  a payer holding USDC on another chain, who by definition may
                  have no Arc wallet to connect. Needs only a recipient and an
                  amount. */}
              <button
                type="button"
                onClick={startCrossChain}
                disabled={bridgeBusy}
                className="w-full flex flex-col items-center gap-1 py-3.5 px-4 border border-signal/40
                           bg-signal/5 hover:bg-signal/10 hover:border-signal/60 transition-colors
                           disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <span className="flex items-center gap-2 text-signal font-mono text-sm">
                  <span aria-hidden className="text-base leading-none">⇄</span>
                  {bridgeBusy ? "Preparing…" : "Pay with USDC from another chain"}
                </span>
                <span className="text-ink-dim text-[11px] font-mono tracking-wide">
                  {/* Only the Solana route genuinely needs no EVM wallet -- the
                      Base/Polygon route signs with the connected one. The old
                      blanket "no Arc wallet needed" was true for one of the
                      three. */}
                  Solana · Base · Arbitrum · Optimism · Avalanche · +7 more
                </span>
              </button>
              {bridgeError && (
                <p className="text-danger text-sm font-mono text-center">{bridgeError}</p>
              )}

              <div className="text-center">
                <p className="text-ink-dim text-sm">
                  Running a business?{" "}
                  <Link href="/dashboard" className="text-signal hover:underline">
                    Sign in as a merchant →
                  </Link>
                </p>
              </div>
            </motion.div>
          )}

          {step === "confirm" && (
            <motion.div
              key="confirm"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              className="bg-surface border border-border p-6"
            >
              <SendConfirm
                recipient={recipient}
                amount={amount}
                recipientCurrency={recipientCurrency}
                payerCurrency={payerCurrency}
                onBack={() => setStep("input")}
                onReset={() => {
                  setStep("input");
                  setRecipient("");
                  setAmount("");
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <MobileNav />
    </div>
  );
}
