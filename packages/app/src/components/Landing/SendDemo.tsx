"use client";

import { useEffect, useRef, useState } from "react";
import { TokenIcon } from "@/components/Shared/TokenBadge";

// A scripted walkthrough of a customer settling a supplier invoice: the
// fields type themselves so a first-time visitor sees how the flow works
// without connecting a wallet. Deliberately NOT the real form — nothing here
// touches a chain, a balance, or a signer. The real thing lives at /send.
//
// Framed as a business paying a business, because that is who Conduit is
// for: a named merchant, an invoice reference, an amount with an invoice
// shape rather than a round consumer number.
const RECIPIENT = "Meridian Supply Co.";
const INVOICE = "INV-2041";
const AMOUNT = "4,250.00";

type Phase = "typing-address" | "typing-amount" | "routing" | "settled";

export function SendDemo() {
  const [address, setAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState<Phase>("typing-address");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const at = (ms: number, fn: () => void) => timers.current.push(setTimeout(fn, ms));
    let t = 400;

    const run = () => {
      // Reset for the next loop.
      setAddress("");
      setAmount("");
      setPhase("typing-address");
      t = 400;

      RECIPIENT.split("").forEach((_, i) => {
        t += 55;
        at(t, () => setAddress(RECIPIENT.slice(0, i + 1)));
      });

      t += 450;
      at(t, () => setPhase("typing-amount"));
      AMOUNT.split("").forEach((_, i) => {
        t += 110;
        at(t, () => setAmount(AMOUNT.slice(0, i + 1)));
      });

      t += 500;
      at(t, () => setPhase("routing"));
      t += 1600;
      at(t, () => setPhase("settled"));
      t += 3200;
      at(t, run);
    };

    run();
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  return (
    <div className="w-full max-w-sm mx-auto" aria-hidden="true">
      <div className="border border-border bg-surface p-5 space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono text-ink-dim uppercase tracking-widest">
            Supplier invoice
          </span>
          <span className="text-[9px] font-mono text-ink-dim uppercase tracking-widest border border-border px-1.5 py-0.5">
            {INVOICE}
          </span>
        </div>

        {/* Recipient */}
        <div className="space-y-1.5">
          <p className="text-[10px] font-mono text-ink-dim uppercase tracking-wider">Pay</p>
          <div className="border border-border bg-bg px-3 py-2.5 font-mono text-sm text-ink min-h-[38px]">
            {address}
            {phase === "typing-address" && <Caret />}
          </div>
        </div>

        {/* Amount they receive */}
        <div className="space-y-1.5">
          <p className="text-[10px] font-mono text-ink-dim uppercase tracking-wider">
            They receive
          </p>
          <div className="border border-border bg-bg px-3 py-2.5 flex items-center gap-2 min-h-[42px]">
            <span className="font-display text-xl text-ink-dim">€</span>
            <span className="font-display text-xl text-ink">{amount}</span>
            {phase === "typing-amount" && <Caret />}
            <span className="ml-auto flex items-center gap-1.5 text-xs font-mono text-ink-dim">
              <TokenIcon currency="EURC" px={16} />
              EURC
            </span>
          </div>
        </div>

        {/* Route */}
        <div
          className={`border border-border bg-bg px-3 py-2.5 space-y-2 transition-opacity duration-500 ${
            phase === "routing" || phase === "settled" ? "opacity-100" : "opacity-0"
          }`}
        >
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="flex items-center gap-1.5 text-ink-dim">
              <TokenIcon currency="USDC" px={16} />
              You hold USDC
            </span>
            <span className="text-signal">→</span>
            <span className="flex items-center gap-1.5 text-ink-dim">
              <TokenIcon currency="EURC" px={16} />
              They invoice EURC
            </span>
          </div>
          <div className="flex items-center gap-2 text-[10px] font-mono text-ink-dim">
            {phase === "settled" ? (
              <>
                <span className="w-1.5 h-1.5 bg-signal" />
                <span className="text-signal">Settled</span>
                <span>via Circle StableFX</span>
              </>
            ) : (
              <>
                <span className="w-1.5 h-1.5 bg-signal animate-pulse" />
                <span>Finding the best route...</span>
              </>
            )}
          </div>
        </div>
      </div>

    </div>
  );
}

function Caret() {
  return <span className="inline-block w-[2px] h-[1em] bg-signal align-middle animate-pulse" />;
}
