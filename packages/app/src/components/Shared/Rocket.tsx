"use client";

// The waiting state for a payment in flight.
//
// It replaced a bordered div with border-t-transparent and animate-spin — the
// "C" that spun on every settle screen. That spinner had two problems. It is
// the same one every website uses, so it says nothing about what is happening;
// and it spins at a constant rate forever, which reads as "stuck" the moment a
// transaction takes more than a couple of seconds, which is exactly when the
// payer is most anxious.
//
// A rocket says the thing that is actually true: something has left, it is on
// its way, and there is a moment when it arrives. The launch is the receipt.
//
// Drawn as flat polygons rather than curves on purpose. The rest of this
// product is a monospace grid with hard edges, so a soft gradient rocket would
// look borrowed from somewhere else.

interface RocketProps {
  /** "launch" plays the flight once, for a settled payment. */
  state?: "waiting" | "launch";
  size?: number;
  className?: string;
}

export function Rocket({ state = "waiting", size = 64, className = "" }: RocketProps) {
  const launching = state === "launch";
  return (
    <div
      className={`relative mx-auto ${className}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={launching ? "Payment sent" : "Payment in progress"}
    >
      <svg
        viewBox="0 0 48 64"
        width={size}
        height={size}
        fill="none"
        className={launching ? "rocket-launch" : "rocket-hover"}
        aria-hidden
      >
        {/* Exhaust. Two flames on different flicker intervals so it reads as
            combustion rather than a pulsing shape. */}
        <g className="rocket-flame">
          <polygon points="24,62 18,46 30,46" fill="var(--signal)" opacity="0.35" />
          <polygon points="24,55 21,44 27,44" fill="var(--signal)" opacity="0.8" />
        </g>

        {/* Fins */}
        <polygon points="14,44 6,50 14,34" fill="var(--signal)" opacity="0.55" />
        <polygon points="34,44 42,50 34,34" fill="var(--signal)" opacity="0.55" />

        {/* Body: nose cone plus fuselage, one silhouette. */}
        <polygon points="24,2 34,20 34,46 14,46 14,20" fill="var(--signal)" />

        {/* Window, punched in the page background so it reads as a hole rather
            than a dot painted on top. */}
        <circle cx="24" cy="22" r="4.5" fill="var(--bg, #050505)" />
      </svg>
    </div>
  );
}
