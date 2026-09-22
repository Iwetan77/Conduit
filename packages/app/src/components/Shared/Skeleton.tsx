// Route-level loading shells. A page that shows its structure in ~200ms
// reads as faster than one that shows everything at 800ms, so these render
// the real layout (nav bar height, card blocks, column widths) rather than a
// spinner or a blank screen.
export function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div className={`bg-surface border border-border animate-pulse ${className}`} />;
}

export function PageSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="min-h-screen">
      {/* Matches the fixed nav's height so content doesn't jump when it mounts */}
      <div className="h-16 border-b border-border" />
      <main className="max-w-2xl mx-auto px-4 pt-10 pb-24 space-y-6">
        <div className="space-y-2">
          <SkeletonBlock className="h-8 w-48" />
          <SkeletonBlock className="h-4 w-72" />
        </div>
        <div className="space-y-3">
          {Array.from({ length: rows }).map((_, i) => (
            <SkeletonBlock key={i} className="h-20" />
          ))}
        </div>
      </main>
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div>
      <header className="mb-8">
        <div className="w-8 h-0.5 bg-signal mb-3" />
        <SkeletonBlock className="h-9 w-56" />
        <SkeletonBlock className="h-4 w-96 max-w-full mt-2" />
        <div className="h-px bg-border mt-5" />
      </header>

      <div className="border border-border bg-surface p-6 mb-6 space-y-3">
        <SkeletonBlock className="h-3 w-40" />
        <SkeletonBlock className="h-10 w-48" />
        <SkeletonBlock className="h-3 w-32" />
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <SkeletonBlock className="h-10 flex-1" />
        <SkeletonBlock className="h-10 w-full sm:w-44" />
      </div>

      <div className="border border-border bg-surface divide-y divide-border">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="p-4">
            <SkeletonBlock className="h-4 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
