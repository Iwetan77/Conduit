// The origin that goes INTO a shareable link.
//
// Not window.location.origin. That is the host the person happens to be
// browsing right now, and on a preview deployment it is
// "useconduit-app.vercel.app" -- so every link and QR generated from a preview
// carried the preview host, was pasted into WhatsApp, and outlived the
// deployment that made it. The API had already been fixed to emit the real
// domain in hosted_url; the browser was quietly overwriting it with its own
// location on the way to the card.
//
// A shareable link's host is a property of the PRODUCT, not of the tab it was
// created in. So it comes from configuration, with one deliberate exception
// below.
const CANONICAL = "https://useconduit.xyz";

/**
 * Where payment links should point.
 *
 * Order matters:
 *
 *  1. NEXT_PUBLIC_APP_URL, so a deployment can say what it is. Inlined at build
 *     time, which is why it is safe to read during a server render.
 *  2. The canonical domain. This is the fallback rather than the current origin
 *     precisely because the current origin is what caused the bug.
 *  3. localhost, and only localhost, wins over both -- a link made while
 *     developing has to be openable on the machine that made it, and a
 *     useconduit.xyz link would send you to production with an id that only
 *     exists in your local database.
 *
 * Stable between the server render and the first client render for every case
 * except localhost, which never server-renders for a real user.
 */
export function shareableOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  if (typeof window !== "undefined") {
    const { origin, hostname } = window.location;
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".local")) {
      return origin;
    }
  }
  return CANONICAL;
}

/**
 * The full public URL for a payment link or intent.
 *
 * Prefer the API's own `hosted_url` when a response carries one -- the server
 * builds it from CONDUIT_APP_BASE_URL and is the authority. This exists for the
 * places that have only an id: links read straight off the chain, where no API
 * response was involved at all.
 */
export function payUrlFor(id: string): string {
  return `${shareableOrigin()}/pay/${id}`;
}
