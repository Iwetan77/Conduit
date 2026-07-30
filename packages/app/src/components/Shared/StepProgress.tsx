"use client";

interface StepProgressProps {
  steps: string[];
  current: number;
}

export function StepProgress({ steps, current }: StepProgressProps) {
  return (
    <div className="flex items-center justify-center gap-2 mx-auto font-mono text-scale-2">
      {steps.map((step, i) => (
        <div key={step} className="flex items-center gap-2">
          <span
            className={
              i < current
                ? "text-ink"
                : i === current
                ? "text-signal"
                : "text-ink-dim"
            }
          >
            {String(i + 1).padStart(2, "0")} {step}
          </span>
          {i < steps.length - 1 && <span className="text-ink-dim">·</span>}
        </div>
      ))}
    </div>
  );
}
