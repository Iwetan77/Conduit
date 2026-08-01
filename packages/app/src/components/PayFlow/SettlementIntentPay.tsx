"use client";

import { useEffect, useState } from "react";
import { usePublicIntent } from "@/lib/use-public-intent";
import { useAccount } from "wagmi";
import type { Currency, PaymentReceipt } from "@conduit/sdk/lite";
import { currencyDecimals } from "@conduit/sdk/lite";
import type { Eip1193Provider } from "ethers";
import { type PublicSettlementIntent } from "@/lib/conduit-api";
import { formatAmountRaw, shortenAddress } from "@/lib/format";
import { isoToToken } from "@/lib/currencies";
import { CrossChainBridge } from "./CrossChainBridge";
import { PayerCurrencyPicker } from "@/components/SendFlow/PayerCurrencyPicker";
import { RoutePreview } from "@/components/SendFlow/RoutePreview";
import { ReceiptCard } from "@/components/Shared/ReceiptCard";
import { WalletConnectCompact } from "@/components/Shared/WalletConnect";

interface SettlementIntentPayProps {
  intentId: string;
}

// Payer surface for the B2B settlement_intents API (si_ ids) -- distinct
// from the older on-chain declaration flow this route also serves. If
// source_chain is anything other than "arc", the payer is bridging in via
// CCTP and CrossChainBridge drives the rest of this page.
export function SettlementIntentPay({ intentId }: SettlementIntentPayProps) {
  const [showAddress, setShowAddress] = useState(false);

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

      <div className="border border-border bg-surface p-4 space-y-1">
        <p className="text-ink-dim text-xs uppercase tracking-wider font-mono">Requesting</p>
        <p className="text-ink font-mono text-2xl">
          {formatAmountRaw(BigInt(intent.amount), currencyDecimals(isoToToken(intent.settle_currency)))}{" "}
          {intent.settle_currency}
        </p>
      </div>

      {intent.source_chain !== "arc" ? (
        <CrossChainBridge intentId={intentId} intent={intent} />
      ) : (
        <ArcWalletPay intent={intent} />
      )}
    </div>
  );
}

// Direct checkout from a wallet already funded on Arc.
//
// Two genuinely different settlement paths, chosen by whether the payer's
// currency matches the merchant's:
//
//   same-currency  -> on-chain via ConduitRouter/AtomicSettler (SDK pay()),
//                     sub-second, no FX involved.
//   cross-currency -> Circle StableFX through the Conduit API:
//                     quote -> payer signs -> prepare -> payer signs ->
//                     confirm. This is the ONLY working cross-currency route;
//                     the old on-chain AMM path had no USDC/EURC pool on Arc
//                     and could never settle.
//
// Neither path needs API credentials: the payer's wallet signatures are the
// only authority that moves their funds.
function ArcWalletPay({ intent }: { intent: PublicSettlementIntent }) {
  const { address, isConnected } = useAccount();
  const [mounted, setMounted] = useState(false);
  const [payerCurrency, setPayerCurrency] = useState<Currency>("USDC");
  const [step, setStep] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [receipt, setReceipt] = useState<PaymentReceipt | null>(null);
  // A failed transaction — distinct from the outer component's load error,
  // which means the intent itself could not be fetched.
  const [txError, setTxError] = useState("");
  // Real, stage-by-stage FX progress (cross-currency only) — each string is
  // set when that step actually starts, never on a timer.
  const [fxStage, setFxStage] = useState("");
  const [fxDone, setFxDone] = useState(false);
  const [fxTx, setFxTx] = useState("");

  useEffect(() => { setMounted(true); }, []);

  const settleToken = isoToToken(intent.settle_currency) as Currency;
  const amountRaw = BigInt(intent.amount);
  const amountHuman = formatAmountRaw(amountRaw, currencyDecimals(settleToken));

  const handlePay = async () => {
    if (!address) return;
    setStep("pending");
    setTxError("");
    try {
      if (payerCurrency === settleToken) {
        // Same currency: straight on-chain settlement, no FX.
        setFxStage("Settling on-chain…");
        const { ConduitClient } = await import("@conduit/sdk");
        const { ethers } = await import("ethers");
        const browserProvider = new ethers.BrowserProvider(
          (window as unknown as { ethereum: Eip1193Provider }).ethereum
        );
        const client = ConduitClient.fromBrowserProvider(browserProvider, "");
        const result = await client.pay({
          recipient: intent.settle_address as `0x${string}`,
          amount: amountRaw,
          currency: settleToken,
          payerToken: payerCurrency,
        });
        setReceipt(result);
        setStep("success");
        return;
      }

      // Cross-currency: Circle StableFX via the API. Real, polled progress —
      // two wallet signatures, never a timed animation.
      const { quoteSettlementIntent, prepareSettlementIntent, confirmSettlementIntent } =
        await import("@/lib/conduit-api");
      const { signTypedDataWithWallet } = await import("@/lib/sign-typed-data");

      setFxStage("Getting a rate from Circle StableFX…");
      const quote = await quoteSettlementIntent(intent.id, payerCurrency);
      if (!quote.typed_data) {
        throw new Error("The FX provider returned no payload to sign.");
      }

      setFxStage(`Rate ${quote.rate} — approve the quote in your wallet`);
      const quoteSignature = await signTypedDataWithWallet(quote.typed_data);

      setFxStage("Creating the trade…");
      const prep = await prepareSettlementIntent(intent.id, quote.typed_data, quoteSignature);

      setFxStage("Approve the transfer in your wallet");
      const fundingSignature = await signTypedDataWithWallet(prep.funding_typed_data);

      setFxStage("Circle is settling to the recipient…");
      const res = await confirmSettlementIntent(intent.id, fundingSignature);

      setFxTx(res.tx_hash ?? "");
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
          Paid to {intent.display_name}. You can close this page.
        </p>
      </div>
    );
  }

  // Cross-currency settles at Circle, not through our router, so there is no
  // on-chain PaymentReceipt to render — show what actually happened instead
  // of forcing it into a receipt shape it doesn't have.
  if (step === "success" && fxDone) {
    return (
      <div className="space-y-3 border border-signal/40 bg-signal/5 p-4 text-center">
        <p className="text-signal font-mono text-sm">
          Paid {amountHuman} {settleToken} to {intent.display_name}
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
        <p className="text-ink-dim text-xs font-mono">You can close this page.</p>
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
      <div className="space-y-3">
        <p className="text-ink-dim text-sm text-center">Connect a wallet to pay</p>
        <WalletConnectCompact />
      </div>
    );
  }

  return (
    <div className="space-y-4">
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
        className="w-full py-4 bg-signal text-signal-ink font-mono text-lg
                   hover:bg-signal/90 transition-colors"
      >
        Pay {amountHuman} {intent.settle_currency}
      </button>
    </div>
  );
}
