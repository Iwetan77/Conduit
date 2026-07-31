"use client";

// /pay/[declarationId] — The most public-facing page.
// Someone who has never heard of Conduit lands here after clicking a link or scanning a QR.
// Rules: no crypto jargon, mobile-first, works without wallet connected, 3 taps to pay.

import { use, useEffect, useState } from "react";
import type { PaymentDeclaration } from "@conduit/sdk";
import { getPublicSettlementIntent } from "@/lib/conduit-api";
import { DeclarationDisplay } from "@/components/PayFlow/DeclarationDisplay";
import { PayConfirm } from "@/components/PayFlow/PayConfirm";
import { SettlementIntentPay } from "@/components/PayFlow/SettlementIntentPay";
import { PaymentLinkPay } from "@/components/PayFlow/PaymentLinkPay";
import { Logo, Wordmark } from "@/components/Shared/Logo";
import { motion } from "framer-motion";

interface PageParams {
  params: Promise<{ declarationId: string }>;
}

// A payer looking at a bare hex address won't pay; the business name is
// what they need to see first -- reflect it in the browser tab too, not
// just the page body (SettlementIntentPay renders display_name/logo_url in
// the body itself).
function useRecipientTitle(intentId: string) {
  useEffect(() => {
    if (!intentId) return;
    getPublicSettlementIntent(intentId)
      .then((intent) => {
        document.title = `Pay ${intent.display_name} · Conduit`;
      })
      .catch(() => {});
  }, [intentId]);
}

export default function PayPage({ params }: PageParams) {
  const { declarationId } = use(params);
  const isSettlementIntent = declarationId.startsWith("si_");
  const isPaymentLink = declarationId.startsWith("pl_");
  useRecipientTitle(isSettlementIntent ? declarationId : "");

  // Three payment surfaces share this route: settlement_intents (si_
  // prefixed ids, the B2B REST API -- including the cross-chain funding
  // flow), payment_links (pl_ prefixed ids, Phase 3's lifecycle layer --
  // turned into a settlement_intent on pay, then handed to the same si_
  // flow), and the older on-chain PaymentDeclaration flow (bytes32 hashes).
  // Same hosted_url shape either way (AppBaseURL + "/pay/" + id), so this
  // dispatches on id format rather than needing separate routes.
  if (isSettlementIntent || isPaymentLink) {
    return (
      <div className="min-h-screen flex flex-col">
        <header className="px-6 py-4 border-b border-border flex justify-center">
          <Logo size="sm" />
        </header>
        <main className="flex-1 max-w-sm mx-auto w-full px-4 py-8 space-y-8">
          {isPaymentLink ? (
            <PaymentLinkPay linkId={declarationId} />
          ) : (
            <SettlementIntentPay intentId={declarationId} />
          )}
        </main>
        <footer className="px-6 py-4 border-t border-border flex justify-center">
          <div className="flex items-center gap-2 text-ink-dim text-xs font-mono">
            <span>Powered by</span>
            <Wordmark size="sm" />
            <span>·</span>
            <span>Arc Testnet</span>
          </div>
        </footer>
      </div>
    );
  }

  return <DeclarationPay declarationId={declarationId} />;
}

function DeclarationPay({ declarationId }: { declarationId: string }) {
  const [declaration, setDeclaration] = useState<PaymentDeclaration | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const load = async () => {
      try {
        const { ConduitClient } = await import("@conduit/sdk");
        const { ethers } = await import("ethers");

        const provider = new ethers.JsonRpcProvider("https://rpc.testnet.arc.network", {
          chainId: 5042002,
          name: "arc-testnet",
        });

        const mockSigner = {
          getAddress: async () => "0x0000000000000000000000000000000000000000",
          sendTransaction: async () => ({ hash: "0x", wait: async () => ({ status: 1, blockNumber: 0 }) }),
        };

        const client = new ConduitClient({ signer: mockSigner });
        const decl = await client.resolveDeclaration(declarationId as `0x${string}`);

        if (!decl.active) {
          setError("This payment link is no longer active.");
          return;
        }

        setDeclaration(decl);
      } catch {
        setError("Payment link not found or invalid.");
      } finally {
        setIsLoading(false);
      }
    };

    load();
  }, [declarationId]);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Minimal header */}
      <header className="px-6 py-4 border-b border-border flex justify-center">
        <Logo size="sm" />
      </header>

      <main className="flex-1 max-w-sm mx-auto w-full px-4 py-8 space-y-8">
        {isLoading && (
          <div className="space-y-6 animate-pulse">
            <div className="h-8 bg-surface" />
            <div className="h-32 bg-surface" />
            <div className="h-14 bg-surface" />
          </div>
        )}

        {error && (
          <div className="text-center py-16 space-y-3">
            <p className="text-4xl">⚠</p>
            <p className="text-ink font-medium">{error}</p>
            <a href="/" className="text-signal text-sm hover:underline">
              Go to Conduit →
            </a>
          </div>
        )}

        {declaration && !isLoading && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-8"
          >
            {/* Who is requesting */}
            <DeclarationDisplay declaration={declaration} />

            {/* Pay button and wallet connect */}
            <PayConfirm declaration={declaration} />
          </motion.div>
        )}
      </main>

      {/* Footer */}
      <footer className="px-6 py-4 border-t border-border flex justify-center">
        <div className="flex items-center gap-2 text-ink-dim text-xs font-mono">
          <span>Powered by</span>
          <Wordmark size="sm" />
          <span>·</span>
          <span>Arc Testnet</span>
        </div>
      </footer>
    </div>
  );
}
