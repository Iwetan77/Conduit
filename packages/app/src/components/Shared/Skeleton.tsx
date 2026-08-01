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
