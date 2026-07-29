import Link from "next/link";
import { DocNav } from "@/components/DocNav";

const GUIDES: { slug: string; title: string; description: string }[] = [
  { slug: "quickstart", title: "Quickstart", description: "Real curl commands to a settled payment, ~15-30s end to end." },
  { slug: "errors", title: "Error codes", description: "Every code, HTTP status, and what to do about it." },
  { slug: "webhooks", title: "Webhook verification", description: "Node, Go, Python — all the same HMAC algorithm." },
  { slug: "currencies", title: "Currencies", description: "Generated from a live GET /v1/currencies call, not hand-written." },
  { slug: "fx-timing", title: "FX timing model", description: "Firm rate at payment time vs. indicative rate for pre-priced invoices." },
  { slug: "fx-capability", title: "FX capability report", description: "What StableFX and the AMM fallback actually cover right now, and why." },
  { slug: "state-diagrams", title: "State diagrams", description: "The settlement intent lifecycle and the nested FX trade lifecycle." },
];

export default function GuidesIndexPage() {
  return (
    <div className="min-h-screen bg-black">
      <DocNav />
      <main className="max-w-3xl mx-auto px-6 pt-28 pb-24">
        <h1 className="text-3xl font-bold text-white mb-2">Guides</h1>
        <p className="text-[#888] mb-10">
          Real docs generated alongside the build — not written separately from what actually
          shipped.
        </p>
        <div className="grid gap-4">
          {GUIDES.map((g) => (
            <Link
              key={g.slug}
              href={`/guides/${g.slug}`}
              className="block p-5 rounded-lg border transition-colors hover:border-[#B2F55A]/40"
              style={{ borderColor: "#1F1F1F", background: "#0a0a0a" }}
            >
              <div className="font-mono text-sm text-white mb-1">{g.title}</div>
              <div className="text-[13px] text-[#888]">{g.description}</div>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
