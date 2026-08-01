import type { Metadata } from "next";
import { DocNav } from "@/components/Docs/DocNav";

// Docs used to be their own Next app with its own root layout. Folded into
// the app, they become a route-group layout: the app's root layout already
// provides <html>, fonts, the grid, and the providers, so this only adds the
// docs chrome (nav + reading column).
export const metadata: Metadata = {
  title: { default: "Conduit Docs", template: "%s — Conduit Docs" },
  description:
    "Documentation for Conduit — accept any stablecoin, settle in yours. Quickstart, API reference, and webhook guides.",
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <DocNav />
      <div className="relative max-w-3xl mx-auto px-6 pt-24 pb-32">{children}</div>
    </>
  );
}
