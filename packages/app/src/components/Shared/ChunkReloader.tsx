"use client";

// Recovering from a deploy that happened while somebody had the page open.
//
// Next.js fingerprints every chunk, so `1235-b9c70d1c.js` becomes
// `1235-a50bb5e7.js` on the next build and the old name stops existing. A
// browser holding HTML from the previous build then asks for a file that is
// gone: Vercel answers 404 with `content-type: text/plain`, the browser refuses
// to execute it under strict MIME checking, and React unmounts into
// "Application error: a client-side exception has occurred".
//
// The window is real and measured, not theoretical. The HTML is edge-cached
// (`x-vercel-cache: HIT`, `x-nextjs-stale-time: 300`), so for up to five
// minutes after a deploy the edge serves the OLD page while the chunks it names
// have already been replaced. Anyone who loads in that window gets a white
// screen, and anyone already sitting on the page gets one the moment they
// navigate to a route whose chunk is loaded lazily.
//
// The honest fix is to reload once. The page the user wants exists; they are
// simply holding a stale reference to it, and a reload fetches the current HTML
// with chunk names that resolve. This does NOT paper over a real error: it
// reacts only to ChunkLoadError, which means exactly one thing.
//
// The guard matters more than the reload. If a chunk 404s for any reason OTHER
// than a deploy -- a genuinely broken build, an asset host that is down -- a
// bare reload becomes an infinite loop that hammers the origin and never shows
// the user anything. sessionStorage remembers that this tab has already tried,
// so a second failure falls through to the error page, which is the honest
// outcome when reloading did not help.
import { useEffect } from "react";

const TRIED = "conduit.chunkReloadAttempted";

function isChunkError(value: unknown): boolean {
  const message =
    value instanceof Error ? `${value.name}: ${value.message}` : String(value ?? "");
  return (
    message.includes("ChunkLoadError") ||
    message.includes("Loading chunk") ||
    // Safari and Firefox word the same failure differently, and a fix that
    // only works in Chrome is not a fix for a payments app.
    message.includes("error loading dynamically imported module") ||
    message.includes("Importing a module script failed")
  );
}

export function ChunkReloader() {
  useEffect(() => {
    const recover = (raw: unknown) => {
      if (!isChunkError(raw)) return;

      try {
        if (sessionStorage.getItem(TRIED)) {
          // Already reloaded once and it happened again. Reloading a second
          // time would loop; let the error boundary show something instead.
          return;
        }
        sessionStorage.setItem(TRIED, "1");
      } catch {
        // Private mode, or storage disabled. Without somewhere to record the
        // attempt there is no way to guarantee this terminates, so do nothing
        // rather than risk a reload loop.
        return;
      }

      // replace(), not reload(): reload can re-submit or restore the same
      // cached document, and the whole point is to fetch the current one.
      window.location.replace(window.location.href);
    };

    const onError = (e: ErrorEvent) => recover(e.error ?? e.message);
    const onRejection = (e: PromiseRejectionEvent) => recover(e.reason);

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // Cleared on a load that goes fine, so a deploy next week gets its own single
  // attempt rather than inheriting a flag from this one.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        sessionStorage.removeItem(TRIED);
      } catch {
        // Nothing to clear if it could not be written in the first place.
      }
    }, 5000);
    return () => clearTimeout(t);
  }, []);

  return null;
}
