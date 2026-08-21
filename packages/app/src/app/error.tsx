"use client";

// The app had ZERO error boundaries.
//
// Without one, a single unhandled render error anywhere in the tree unmounts
// the whole thing and the visitor gets a blank page — on a payment surface,
// during a payment. This catches it, keeps the app's chrome, and offers the two
// things that actually recover: re-render this route, or leave.
//
// Deliberately says nothing about what broke. A stack trace on a checkout page
// tells a payer nothing they can act on, and tells anyone else more about the
// app's internals than they need. The digest is included because it is the one
// token that ties what they saw to what the logs recorded.
import { useEffect } from "react";
import Link from "next/link";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The full error, once, where it can be read — the UI below never shows it.
    console.error("unhandled render error:", error);
  }, [error]);

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-sm w-full border border-border bg-surface p-8 space-y-5 text-center">
        <div className="flex items-center justify-center gap-2">
          <span className="w-2 h-2 bg-danger" />
          <span className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider">
            Something broke
          </span>
        </div>

        <p className="text-ink-dim text-scale-2 leading-relaxed">
          This page failed to load. Nothing you did caused it, and no payment was
          affected by it.
        </p>

        <button
          onClick={reset}
          className="w-full py-3 bg-signal text-signal-ink font-mono
                     hover:bg-signal/90 transition-colors"
        >
          Try again
        </button>

        <Link
          href="/"
          className="block text-scale-1 font-mono text-ink-dim hover:text-ink transition-colors"
        >
          Go to the home page
        </Link>

        {error.digest && (
          <p className="text-scale-1 font-mono text-ink-dim/60 pt-2 border-t border-border">
            Reference {error.digest}
          </p>
        )}
      </div>
    </main>
  );
}
