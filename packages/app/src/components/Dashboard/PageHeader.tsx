"use client";

// One header for every dashboard page.
//
// Before this, each page dropped a bare <h1> straight onto the grid background:
// no separation between "what page am I on" and "the thing I'm working in", so
// a form's first field started immediately under the title and the whole screen
// read as one undifferentiated column. This gives every page the same anatomy —
// a signal rule, the title, one line explaining what the page is for, and a
// slot for the page's primary action — so the heading is visibly its own band.
export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="mb-8">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {/* Short accent rule: the one piece of brand colour every page opens
              with, so pages feel like one product rather than eight screens. */}
          <div className="w-8 h-0.5 bg-signal mb-3" />
          <h1 className="font-display text-3xl font-bold text-ink">{title}</h1>
          {description && (
            <p className="text-ink-dim text-sm mt-1.5 max-w-xl">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="h-px bg-border mt-5" />
    </header>
  );
}

// A bordered surface for a group of related controls or data.
//
// The dark grid runs edge to edge behind everything, so unpanelled content
// floats on it with nothing holding it together. Wrapping a form or a table in
// this gives it an edge, a background a shade above the page, and an optional
// label — which is what makes a screen read as designed rather than assembled.
export function Panel({
  title,
  description,
  action,
  children,
  className = "",
}: {
  title?: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`border border-border bg-surface ${className}`}>
      {(title || action) && (
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-border">
          <div className="min-w-0">
            {title && (
              <h2 className="text-xs font-mono text-ink-dim uppercase tracking-wider">
                {title}
              </h2>
            )}
            {description && <p className="text-ink-dim text-xs mt-1">{description}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

// A single headline number. Used to open a page with the fact the merchant
// actually came to check, instead of making them read a table to find it.
export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="border border-border bg-surface p-5">
      <p className="text-xs font-mono text-ink-dim uppercase tracking-wider">{label}</p>
      <p className="font-display text-2xl font-bold text-ink mt-2 break-words">{value}</p>
      {hint && <p className="text-ink-dim text-xs mt-1">{hint}</p>}
    </div>
  );
}
