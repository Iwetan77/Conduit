import Link from "next/link";

const GUIDES: { slug: string; title: string; description: string }[] = [
  { slug: "quickstart", title: "Quickstart", description: "Real curl commands to a settled payment, ~15-30s end to end." },
  { slug: "payment-gateway", title: "Payment gateway", description: "Drop-in hosted checkout: accept any stablecoin, settle in one currency." },
  { slug: "errors", title: "Error codes", description: "Every code, HTTP status, and what to do about it." },
  { slug: "webhooks", title: "Webhook verification", description: "Node, Go, Python — all the same HMAC algorithm." },
  { slug: "currencies", title: "Currencies", description: "Generated from a live GET /v1/currencies call, not hand-written." },
  { slug: "fx-timing", title: "FX timing model", description: "Firm rate at payment time vs. indicative rate for pre-priced invoices." },
  { slug: "fx-capability", title: "FX capability report", description: "What StableFX and the AMM fallback actually cover right now, and why." },
  { slug: "state-diagrams", title: "State diagrams", description: "The settlement intent lifecycle and the nested FX trade lifecycle." },
  { slug: "payment-links", title: "Payment links", description: "Amount modes, expiry, single vs multi-use, void — and cross-chain funding status." },
  { slug: "point-of-sale", title: "Point of sale", description: "A QR per bill, printed by the till — wiring a restaurant POS to a storefront." },
];

export default function GuidesIndexPage() {
  return (
    <>
        <h1 className="text-3xl font-bold text-ink mb-2">Guides</h1>
        <p className="text-ink-dim mb-10">
          Real docs generated alongside the build — not written separately from what actually
          shipped.
        </p>
        <div className="grid gap-4">
          {GUIDES.map((g) => (
            <Link
              key={g.slug}
              href={`/docs/guides/${g.slug}`}
              className="block p-5 border border-border bg-surface transition-colors hover:border-signal/40"
            >
              <div className="font-mono text-sm text-ink mb-1">{g.title}</div>
              <div className="text-[13px] text-ink-dim">{g.description}</div>
            </Link>
          ))}
        </div>
    </>
  );
}
