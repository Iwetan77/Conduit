import { SkeletonBlock } from "@/components/Shared/Skeleton";

// The dashboard had no loading boundary at all.
//
// Five routes had one -- /history, /pay, /create, /links, /send -- and none of
// the eight dashboard routes did, which are the routes a merchant moves between
// most. Every navigation there went from a full page to nothing to a full page.
//
// Shaped like the real frame on purpose: PageHeader's accent rule, title and
// description line, then a stats panel, then a table. A skeleton whose shape
// differs from the page it precedes is its own flash -- content lands, nothing
// lines up, and everything shifts. These blocks match PageHeader and Panel so
// the swap is a fill, not a rearrangement.
export default function Loading() {
  return (
    <div>
      {/* PageHeader: signal rule, title, description, divider */}
      <header className="mb-8">
        <div className="w-8 h-0.5 bg-signal mb-3" />
        <SkeletonBlock className="h-9 w-56" />
        <SkeletonBlock className="h-4 w-96 max-w-full mt-2" />
        <div className="h-px bg-border mt-5" />
      </header>

      {/* The headline figure most dashboard pages open with */}
      <div className="border border-border bg-surface p-6 mb-6 space-y-3">
        <SkeletonBlock className="h-3 w-40" />
        <SkeletonBlock className="h-10 w-48" />
        <SkeletonBlock className="h-3 w-32" />
      </div>

      {/* Filter row */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <SkeletonBlock className="h-10 flex-1" />
        <SkeletonBlock className="h-10 w-full sm:w-44" />
      </div>

      {/* Table body */}
      <div className="border border-border bg-surface divide-y divide-border">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="p-4">
            <SkeletonBlock className="h-4 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
