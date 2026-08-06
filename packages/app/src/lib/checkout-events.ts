// A tiny in-page signal that a payment just settled, dispatched the instant the
// browser knows (a direct or cross-currency pay completes client-side). The
// embedded-checkout bridge (see PayPageClient's EmbedBridge) listens for it so
// the Conduit inline popup fires onSuccess immediately, instead of waiting up
// to one poll interval. Polling stays as the fallback and as the ONLY signal
// for cross-chain, whose settlement finishes server-side where the browser
// can't see it.
export const CHECKOUT_SETTLED_EVENT = "conduit:checkout-settled";

export function emitCheckoutSettled(intentId: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHECKOUT_SETTLED_EVENT, { detail: { intentId } }));
}
