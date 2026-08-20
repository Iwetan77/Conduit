"use client";

import { pollWithBackoff } from "@/lib/poll";
import Link from "next/link";

// Client body of /pay/[declarationId]. Split out of page.tsx so the route
// file itself can stay a Server Component and export generateMetadata — that
// is the ONLY way WhatsApp/X/Telegram crawlers (which never run JS) get a rich
// preview card. The client-side document.title tweak below still runs for
// in-app SPA navigation; the crawler card comes from the server metadata.

import { useEffect, useState } from "react";
import type { PaymentDeclaration } from "@conduit/sdk/lite";
import { usePublicIntent } from "@/lib/use-public-intent";
import { DeclarationDisplay } from "@/components/PayFlow/DeclarationDisplay";
import { PayConfirm } from "@/components/PayFlow/PayConfirm";
import { SettlementIntentPay } from "@/components/PayFlow/SettlementIntentPay";
import { PaymentLinkPay } from "@/components/PayFlow/PaymentLinkPay";
import { Logo, Wordmark } from "@/components/Shared/Logo";
import { CHECKOUT_SETTLED_EVENT } from "@/lib/checkout-events";
import { motion } from "framer-motion";

// A payer looking at a bare hex address won't pay; the business name is
// what they need to see first -- reflect it in the browser tab too, not
// just the page body (SettlementIntentPay renders display_name/logo_url in
// the body itself).
function useRecipientTitle(intentId: string) {
  // Shares the SAME react-query as SettlementIntentPay below, so setting the
  // tab title costs no extra request (it used to fire a second, identical
  // fetch on every page load).
  const { data: intent } = usePublicIntent(intentId || undefined);

  useEffect(() => {
    if (!intent?.display_name) return;
    const previousTitle = document.title;
    document.title = `Pay ${intent.display_name} · Conduit`;
    // Without this the browser tab kept showing the previous merchant's
    // name after navigating away from their invoice.
    return () => { document.title = previousTitle; };
  }, [intent?.display_name]);
}

// When the hosted checkout is opened inside the Conduit inline popup
// (conduit.js, ?embed=1), it has no way to know the payment finished — the
// settlement is driven by components deep in the tree. This bridges that: it
// polls the public intent status and postMessages the parent window when it
// flips to "settled", which is what conduit.js listens for to fire onSuccess.
// Read-only status, non-sensitive, so "*" targetOrigin is fine (the popup
// validates our origin on its end).
function EmbedBridge({ intentId }: { intentId: string }) {
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Two ways this checkout gets launched, and they finish differently:
    //
    //   Tab mode (desktop)   — conduit.js opened us in a new tab and is
    //     listening; we postMessage "settled" and it closes us.
    //   Redirect mode (mobile / wallet in-app browsers, which cannot open a
    //     tab at all) — conduit.js replaced the merchant's page with us, so
    //     there is nobody to message. We hand the buyer back to the merchant's
    //     return_url instead.
    const isEmbed = new URLSearchParams(window.location.search).get("embed") === "1";
    const target =
      window.opener || (window.parent && window.parent !== window ? window.parent : null);
    const canPost = isEmbed && !!target;

    const post = (status: string) => {
      if (canPost) target!.postMessage({ type: "conduit:checkout", status, intent: intentId }, "*");
    };

    // The return_url is only known from the intent, so fetch it once up front —
    // the settle path can fire from an in-page event with no intent in hand.
    let returnUrl = "";
    import("@/lib/conduit-api")
      .then(({ getPublicSettlementIntent }) => getPublicSettlementIntent(intentId))
      .then((i) => { returnUrl = i.return_url ?? ""; })
      .catch(() => {});

    post("loaded");
    let done = false;
    // Held in a box because settle() is defined before the poll exists -- the
    // in-page event can settle this page without the poll ever ticking.
    const poll: { stop: (() => void) | null } = { stop: null };
    const settle = () => {
      if (done) return;
      done = true;
      post("settled");
      poll.stop?.();
      window.removeEventListener(CHECKOUT_SETTLED_EVENT, onInPage);
      // Redirect mode only: in tab mode conduit.js closes this tab, and
      // navigating here would race that. The merchant confirms the payment
      // server-side (webhook / status) — these params are just a signal.
      if (!canPost && returnUrl) {
        const back = new URL(returnUrl);
        back.searchParams.set("conduit_intent", intentId);
        back.searchParams.set("conduit_status", "settled");
        window.location.replace(back.toString());
      }
    };

    // Instant path: direct and cross-currency pays settle in THIS browser, so
    // the pay component fires this the moment it's done — no poll-interval wait.
    const onInPage = (e: Event) => {
      if ((e as CustomEvent<{ intentId: string }>).detail?.intentId === intentId) settle();
    };
    window.addEventListener(CHECKOUT_SETTLED_EVENT, onInPage);

    // Fallback + the ONLY signal for cross-chain (settled server-side): poll.
    //
    // Ramped rather than flat. A same-currency pay settles on Arc in about a
    // second, and a flat 2.5s interval spent most of its first tick waiting on
    // money that had already landed -- while a slow cross-chain transfer kept
    // asking at that rate for as long as it took. First ticks are now sub
    // second and the tail is cheaper than before.
    poll.stop = pollWithBackoff(async () => {
      // Someone who just opened a payment link directly has nobody to notify
      // and nowhere to return to — the page renders its own receipt, so don't
      // spend API calls on them.
      if (!canPost && !returnUrl) return false;
      const { getPublicSettlementIntent } = await import("@/lib/conduit-api");
      const fresh = await getPublicSettlementIntent(intentId);
      if (fresh.status === "settled") {
        settle();
        return true; // stop: there is nothing after settled
      }
      return false;
    });

    return () => {
      poll.stop?.();
      window.removeEventListener(CHECKOUT_SETTLED_EVENT, onInPage);
    };
  }, [intentId]);
  return null;
}

export function PayPageClient({ declarationId }: { declarationId: string }) {
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
          {isSettlementIntent && <EmbedBridge intentId={declarationId} />}
          {isPaymentLink ? (
            <PaymentLinkPay key={declarationId} linkId={declarationId} />
          ) : (
            <SettlementIntentPay key={declarationId} intentId={declarationId} />
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

        const mockSigner = {
          getAddress: async () => "0x0000000000000000000000000000000000000000",
          sendTransaction: async () => ({ hash: "0x", wait: async () => ({ status: 1, blockNumber: 0 }) }),
        };

        // Read declarations through the same Arc RPC proxy every other browser
        // read uses. Without rpcUrl the SDK falls back to the hardcoded public
        // Arc RPC, which rate-limits/bot-blocks from the browser and made
        // copied declaration links resolve as "not found" at random.
        const client = new ConduitClient({
          signer: mockSigner,
          rpcUrl: process.env.NEXT_PUBLIC_ARC_RPC_URL,
        });
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
            <Link href="/" className="text-signal text-sm hover:underline">
              Go to Conduit →
            </Link>
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
