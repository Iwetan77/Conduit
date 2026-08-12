"use client";

import { useEffect, useRef, useState } from "react";
import { listSettlements, type Settlement } from "@/lib/conduit-api";
import { formatMinorUnits, shortenAddress } from "@/lib/format";

const EXPLORER = process.env.NEXT_PUBLIC_EXPLORER ?? "https://testnet.arcscan.app";

// How often to look for new settlements. Fast enough that a merchant watching
// the dashboard sees a payment land while the customer is still standing
// there; slow enough that a tab left open all day isn't a load problem.
const POLL_MS = 12_000;

// A payment landing should be visible without hunting for it.
//
// Polls rather than streams because there is no socket: the merchant-facing
// API is request/response, and webhooks go server-to-server, not to a browser.
// Polling only while the tab is visible, so a dashboard left open in a
// background tab overnight stops asking.
export function PaymentToasts() {
  const [toasts, setToasts] = useState<Settlement[]>([]);
  // Settlement ids already accounted for. Seeded from the FIRST poll without
  // showing anything: opening the dashboard should not replay every payment
  // ever received as a stack of notifications. Only what arrives while you're
  // watching is news.
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      if (document.visibilityState !== "visible") return;
      let data: Settlement[];
      try {
        data = (await listSettlements()).data ?? [];
      } catch {
        return; // a failed poll is not worth telling anyone about
      }
      if (cancelled) return;

      if (seen.current === null) {
        seen.current = new Set(data.map((s) => s.id));
        return;
      }
      const fresh = data.filter((s) => !seen.current!.has(s.id));
      if (fresh.length === 0) return;
      for (const s of fresh) seen.current.add(s.id);
      // Newest first, and never more than a handful on screen at once.
      setToasts((prev) => [...fresh, ...prev].slice(0, 4));
    };

    const timer = setInterval(check, POLL_MS);
    check();
    // Coming back to the tab should show what landed while it was hidden,
    // without waiting out a full interval.
    document.addEventListener("visibilitychange", check);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);

  const dismiss = (id: string) => setToasts((prev) => prev.filter((t) => t.id !== id));

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-[calc(100vw-2rem)] w-80">
      {toasts.map((s) => (
        <PaymentToast key={s.id} settlement={s} onDismiss={() => dismiss(s.id)} />
      ))}
    </div>
  );
}

function PaymentToast({
  settlement,
  onDismiss,
}: {
  settlement: Settlement;
  onDismiss: () => void;
}) {
  // Auto-dismiss, but not so fast that a glance away misses it. Cleared on
  // unmount so a manual dismiss doesn't leave a timer firing into nothing.
  useEffect(() => {
    const t = setTimeout(onDismiss, 12_000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="border border-signal/40 bg-surface shadow-lg toast-in">
      <div className="flex items-start gap-3 p-4">
        <span className="w-2 h-2 mt-1.5 shrink-0 bg-signal animate-pulse" />
        <div className="min-w-0 flex-1">
          <p className="text-ink text-sm">
            {/* payer_address is absent for cross-chain, where the address that
                moves funds on Arc is Conduit's relayer rather than the payer.
                "Someone" is honest; naming our own relayer would not be. */}
            <span className="font-mono">
              {settlement.payer_address ? shortenAddress(settlement.payer_address) : "Someone"}
            </span>{" "}
            sent you{" "}
            <span className="font-medium">
              {formatMinorUnits(settlement.settle_amount, settlement.settle_currency)}
            </span>
          </p>
          {settlement.reference && (
            <p className="text-ink-dim text-xs mt-0.5 truncate">{settlement.reference}</p>
          )}
          <a
            href={`${EXPLORER}/tx/${settlement.tx_hash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-signal text-xs font-mono hover:underline inline-block mt-1.5"
          >
            View on ArcScan →
          </a>
        </div>
        <button
          onClick={onDismiss}
          className="shrink-0 text-ink-dim hover:text-ink text-sm leading-none"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}
