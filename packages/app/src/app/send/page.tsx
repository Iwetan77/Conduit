"use client";

import Link from "next/link";

import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import { usePayerIdentity } from "@/lib/use-payer-identity";
import { usePayerUsdc, routeForAmount } from "@/lib/use-payer-usdc";
import { chainLabel, usdcDisplay } from "@/lib/unified-balance";
import { isAddress } from "viem";
import { Nav, MobileNav } from "@/components/Shared/Nav";
import { AddressInput } from "@/components/SendFlow/AddressInput";
import { AmountInput } from "@/components/SendFlow/AmountInput";
import { RoutePreview } from "@/components/SendFlow/RoutePreview";
import { SendConfirm } from "@/components/SendFlow/SendConfirm";
import { CrossChainBridge } from "@/components/PayFlow/CrossChainBridge";
import type { PublicSettlementIntent } from "@/lib/conduit-api";
import { PayerCurrencyPicker } from "@/components/SendFlow/PayerCurrencyPicker";
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
  // Who is paying, across both wallet families. isConnected above is still
  // wagmi's answer for EVM specifically; identity is the answer for the page.
  const { identity } = usePayerIdentity();
  // Where their USDC is, off Arc. Read at connect time so the route is known
  // before the payer commits to one, rather than discovered inside it.
  const sourceUsdc = usePayerUsdc({
    address: identity?.address,
    family: identity?.kind,
    enabled: !!identity,
  });
  const [step, setStep] = useState<Step>("input");

  useEffect(() => { setMounted(true); }, []);

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [recipientCurrency, setRecipientCurrency] = useState<Currency>("USDC");
  const [payerCurrency, setPayerCurrency] = useState<Currency>("USDC");
  const [payerBalances, setPayerBalances] = useState<BalanceMap>({});
  // Cross-CHAIN funding still lives on THIS step rather than the confirm one,
  // but it is no longer a separate door.
  //
  // It used to sit outside the connect gate entirely, because a payer whose
  // USDC is on Solana had no wallet the gate would accept -- so the one path
  // built for them was reachable only by first connecting the exact wallet
  // they did not have. They can connect that wallet now (usePayerIdentity), so
  // this is simply where the Send button lands when the money is off Arc.
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

  // What this send actually costs in the payer's currency (exact-out
  // quote for cross-currency, 1:1 for same), checked against their real
  // balance BEFORE the confirm step so nobody walks into a revert.
  const required = useRequiredPayerAmount(payerCurrency, recipientCurrency, amount);
  const payerBalance = payerBalances[payerCurrency];
  const insufficient =
    required.data !== undefined && payerBalance !== undefined && payerBalance < required.data;

  // Which route can actually settle this, decided from where the money is
  // rather than from which network the wallet happens to be pointed at.
  //
  // Arc only counts for an EVM wallet: payerBalances is read against the wagmi
  // address, and a Solana wallet cannot sign on Arc at all, so crediting it an
  // Arc balance would offer a route that fails at the last step.
  const arcUsdc = identity?.kind === "evm" ? (payerBalances.USDC ?? 0n) : 0n;
  const route =
    required.data !== undefined
      ? routeForAmount(required.data, arcUsdc, sourceUsdc.funded)
      : null;

  // Cross-currency is a first-class send, not a merchant-only feature: it
  // settles through Circle StableFX against a settlement intent that /send
  // creates against its own personal account. No payment link, no merchant
  // dashboard. SendConfirm drives it end to end.
  const crossCurrency = payerCurrency !== recipientCurrency;
  // "Insufficient" now means insufficient EVERYWHERE, not just on Arc. A payer
  // holding nothing on Arc but plenty on Base was previously blocked by the
  // Arc-only check before the cross chain route was ever considered.
  const canProceed =
    isAddress(recipient) &&
    parseFloat(amount) > 0 &&
    identity !== null &&
    route?.kind !== "insufficient" &&
    (route?.kind === "cross_chain" || !insufficient);

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
              <CrossChainBridge
                intentId={bridgeIntent.id}
                intent={bridgeIntent}
                /* Already read when the wallet connected. Without this the
                   payer waits through the same twelve chain fan out a second
                   time, after pressing Send, for the same answer. */
                knownUsdc={sourceUsdc.unified}
              />
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

                {/* What this wallet actually holds, per chain.
                    A connected wallet used to show nothing but an x to
                    disconnect, so the one question a payer has at this point --
                    do I have the money, and where -- had no answer on screen.
                    Per chain, never summed: one payment draws from one chain,
                    so a total would promise something the rails cannot do. */}
                {mounted && identity && (sourceUsdc.funded.length > 0 || sourceUsdc.loading) && (
                  <div className="border border-border bg-surface px-3 py-2 space-y-1">
                    <p className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider">
                      Your USDC
                    </p>
                    {sourceUsdc.loading && sourceUsdc.funded.length === 0 ? (
                      <p className="text-scale-1 font-mono text-ink-dim">Reading your balances…</p>
                    ) : (
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        {sourceUsdc.funded.map((c) => (
                          <span key={c.chain} className="text-scale-1 font-mono text-ink">
                            {usdcDisplay(c.minor)}{" "}
                            <span className="text-ink-dim">on {chainLabel(c.chain)}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}

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

              {!mounted || !identity ? (
                // A prompt, not a second set of buttons.
                //
                // This used to render its own <WalletConnect/>, which put two
                // connect controls on one screen -- and once a Solana wallet
                // was connected they disagreed, the nav still offering
                // "Connect Wallet" while this one showed the chip. The nav is
                // the single place a wallet is connected or disconnected; this
                // says what to do and points at it.
                <div className="text-center space-y-2 border border-border bg-surface/40 py-6 px-4">
                  <p className="text-ink text-sm font-mono">
                    Connect the wallet holding your USDC
                  </p>
                  <p className="text-ink-dim text-xs font-mono">
                    Use Connect Wallet at the top of the page. Any chain works — Arc,
                    Solana, Base and nine others.
                  </p>
                </div>
              ) : (
                <>
                  {/* The route, named before anything happens.
                      A payer should know they are about to spend their Base
                      balance before they press the button, not discover it on
                      the next screen. */}
                  {route?.kind === "cross_chain" && (
                    <p className="text-center text-scale-1 font-mono text-signal">
                      Paying from {chainLabel(route.chain)}
                    </p>
                  )}
                  {sourceUsdc.loading && !route && (
                    <p className="text-center text-scale-1 font-mono text-ink-dim">
                      Checking your balances…
                    </p>
                  )}

                  {/* One button, whichever route wins.
                      There used to be a second one here for paying from
                      another chain. It existed because a Solana payer had no
                      wallet to connect and so could never reach this one; now
                      that they can connect, it is the same action. */}
                  <button
                    onClick={() => {
                      if (route?.kind === "cross_chain") void startCrossChain();
                      else setStep("confirm");
                    }}
                    disabled={!canProceed || bridgeBusy}
                    className="w-full py-4 bg-signal text-signal-ink
                               font-mono text-xl hover:bg-signal/90 transition-colors
                               disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    {bridgeBusy ? "Preparing…" : "Review Payment →"}
                  </button>
                </>
              )}

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
