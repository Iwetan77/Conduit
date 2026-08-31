"use client";

// Treasury send — the merchant paying someone else a one-off amount.
// This lives INSIDE the authenticated dashboard (spec: "the merchant
// sending a one-off payment themselves (treasury) lives inside the
// dashboard as 'Send', not on the public surface"). It was previously the
// public app homepage — a pre-split consumer leftover.

import { useHydrated } from "@/lib/use-hydrated";
import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import { isAddress } from "viem";
import { useMyAccount } from "@/lib/queries";
import { useCircleAccount } from "@/lib/circle/connection";
import { shortenAddress } from "@/lib/format";
import { AddressInput } from "@/components/SendFlow/AddressInput";
import { AmountInput } from "@/components/SendFlow/AmountInput";
import { RoutePreview } from "@/components/SendFlow/RoutePreview";
import { SendConfirm } from "@/components/SendFlow/SendConfirm";
import { PayerCurrencyPicker } from "@/components/SendFlow/PayerCurrencyPicker";
import { WalletConnect } from "@/components/Shared/WalletConnect";
import type { Currency } from "@conduit/sdk/lite";
import { tryParseAmount } from "@/lib/format";
import { PageHeader } from "@/components/Dashboard/PageHeader";

type Step = "input" | "confirm";

export default function SendPage() {
  const mounted = useHydrated();
  const { address: connected, isConnected } = useAccount();
  const [step, setStep] = useState<Step>("input");

  // The BUSINESS's money, not its owner's.
  //
  // This screen read the connected wallet, which for a merchant signed in with
  // Google is the wallet they signed in WITH -- their own, personally. So the
  // merchant Send page listed the owner's personal holdings and would have spent
  // them, under a heading that says the business is paying. Those are two
  // different addresses since businesses were given settlement wallets of their
  // own, and this is the company's screen, so it reads the company's address.
  const { data: account } = useMyAccount();
  const treasury = account?.settle_address;

  // Can the connected wallet actually sign for that address?
  //
  // Yes, for a Google sign-in, and this used to say no. The old rule was
  // "only when they are the same address", on the reasoning that a Circle
  // wallet's key material is bound to the wallet the session signed in with.
  // It is bound to the USER. One Circle user holds both wallets -- the
  // personal one and the business's settlement wallet -- the same user token
  // authorises both, and Circle's transfer API simply takes a wallet_id. The
  // settlement wallet is already sitting in session.wallets.
  //
  // So a merchant signed in with Google can spend the business's money, which
  // is what this screen has always said it does. lib/settlement-signer pins
  // the provider to the settle address, and refuses loudly if that address is
  // not one this session owns -- the silent failure being guarded against is
  // showing one wallet's balance and spending another's.
  //
  // An injected wallet is the other case, and there the old rule still holds:
  // MetaMask signs for the address it is connected as and no other.
  const isCircleSession = useCircleAccount().connected;
  const canSignForTreasury =
    !!treasury &&
    (isCircleSession ||
      (!!connected && treasury.toLowerCase() === connected.toLowerCase()));

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [recipientCurrency, setRecipientCurrency] = useState<Currency>("USDC");
  const [payerCurrency, setPayerCurrency] = useState<Currency>("USDC");

  const canProceed =
    isAddress(recipient) && parseFloat(amount) > 0 && isConnected && canSignForTreasury;

  return (
    <div className="max-w-lg mx-auto">
      <PageHeader title="Send" description="Pay anyone in the currency they want, from whatever you hold." />

      {step === "input" && (
        <div className="space-y-6">
          <div className="bg-surface border border-border p-6 space-y-6">
            <AddressInput value={recipient} onChange={setRecipient} />

            <AmountInput
              value={amount}
              onChange={setAmount}
              currency={recipientCurrency}
              onCurrencyChange={(c) => setRecipientCurrency(c)}
              label="They receive"
            />

            {/* Balance-aware: shows only currencies this treasury wallet
                actually holds, never a static list. The BUSINESS's wallet —
                see the note on `treasury` above. */}
            <PayerCurrencyPicker
              value={payerCurrency}
              onChange={setPayerCurrency}
              address={treasury}
            />

            {/* Which account the money leaves. Named, always, because there are
                now two wallets in play and the difference between them is the
                difference between company money and the owner's own. */}
            {treasury && (
              <p className="text-ink-dim text-xs font-mono">
                Paying from {shortenAddress(treasury, 5)} · your settlement wallet
              </p>
            )}

            {amount && recipient && (
              <RoutePreview
                payerCurrency={payerCurrency}
                recipientCurrency={recipientCurrency}
                recipientAmount={amount}
                recipientAmountRaw={tryParseAmount(amount, recipientCurrency)}
              />
            )}
          </div>

          {!mounted || !isConnected ? (
            <div className="space-y-3">
              <p className="text-ink-dim text-sm">
                Connect the wallet that holds your settlement address. This
                screen spends the business&apos;s money, not your own.
              </p>
              <WalletConnect />
            </div>
          ) : (
            <div className="space-y-3">
              {/* Refused rather than redirected.
                  The connected wallet cannot sign for the settlement address,
                  so the only two things this button could do are pay from the
                  wrong account or fail at the signature. Saying so here is the
                  only version that does not cost somebody money or time. */}
              {!canSignForTreasury && treasury && (
                <p className="text-danger text-xs">
                  You are signed in with {shortenAddress(connected ?? "", 5)}, which
                  cannot sign for your settlement wallet{" "}
                  {shortenAddress(treasury, 5)}. Sending the business&apos;s money
                  needs that wallet connected — otherwise this would spend your
                  personal balance instead.
                </p>
              )}
              <button
                onClick={() => setStep("confirm")}
                disabled={!canProceed}
                className="w-full py-3 bg-signal text-signal-ink
                           font-mono text-sm hover:bg-signal/90 transition-colors
                           disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Review payment →
              </button>
            </div>
          )}
        </div>
      )}

      {step === "confirm" && (
        <div className="bg-surface border border-border p-6">
          <SendConfirm
            // The business pays, so the business's wallet signs.
            spendFrom={treasury}
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
        </div>
      )}
    </div>
  );
}
