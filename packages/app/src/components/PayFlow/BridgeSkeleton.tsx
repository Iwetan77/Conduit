// The shape CrossChainBridge is about to be.
//
// That component is a dynamic(ssr:false) import, so between the click and its
// chunk arriving it rendered NOTHING -- and "nothing" is not neutral. On /send
// it left the bare page with a lone "Back" button under it for a beat, so the
// payer saw the form they had just left reappear, empty, and then be replaced by
// the pay panel. A screen showing up out of order reads as a bug even when the
// payment is fine.
//
// Dimensions here are deliberately close to the real confirm panel (amount
// block, route line, recipient block, button) so the swap-in does not shift the
// page. A skeleton of the wrong size is its own flash.
export function BridgeSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-live="polite">
      <span className="sr-only">Preparing your payment…</span>
      <div className="border border-border bg-surface p-5 space-y-4">
        <div className="space-y-2">
          <div className="h-3 w-20 bg-border" />
          <div className="h-9 w-40 bg-border" />
          <div className="h-3 w-48 bg-border" />
        </div>
        <div className="h-px bg-border" />
        <div className="h-3 w-32 bg-border" />
        <div className="h-px bg-border" />
        <div className="space-y-2">
          <div className="h-3 w-24 bg-border" />
          <div className="h-6 w-28 bg-border" />
        </div>
      </div>
      <div className="h-14 w-full bg-border" />
    </div>
  );
}
