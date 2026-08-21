"use client";

// The dashboard's own boundary, so a failure on one page does not take the
// sidebar and the session with it.
//
// The root app/error.tsx replaces the ENTIRE page, which for a merchant means
// losing the nav and having to find their way back in. Nesting one here keeps
// the dashboard chrome standing and scopes the failure to the panel that
// actually broke — Settlements can fail while Links still works.
import { useEffect } from "react";
import Link from "next/link";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("dashboard render error:", error);
  }, [error]);

  return (
    <div>
      <header className="mb-8">
        <div className="w-8 h-0.5 bg-danger mb-3" />
        <h1 className="font-display text-3xl font-bold text-ink">This page didn&apos;t load</h1>
        <p className="text-ink-dim text-sm mt-1.5 max-w-xl">
          Something went wrong rendering it. Your account and your settlements are
          unaffected — this is the page, not the data behind it.
        </p>
        <div className="h-px bg-border mt-5" />
      </header>

      <div className="flex flex-wrap gap-3">
        <button
          onClick={reset}
          className="px-5 py-3 bg-signal text-signal-ink font-mono
                     hover:bg-signal/90 transition-colors"
        >
          Try again
        </button>
        <Link
          href="/dashboard/settlements"
          className="px-5 py-3 border border-border font-mono text-ink-dim
                     hover:text-ink hover:border-ink-dim transition-colors"
        >
          Back to Settlements
        </Link>
      </div>

      {error.digest && (
        <p className="text-scale-1 font-mono text-ink-dim/60 mt-6">
          Reference {error.digest}
        </p>
      )}
    </div>
  );
}
