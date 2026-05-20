"use client";

interface StepProgressProps {
  steps: string[];
  current: number;
}

export function StepProgress({ steps, current }: StepProgressProps) {
  return (
    <div className="flex items-center justify-center gap-0 mx-auto">
      {steps.map((step, i) => (
        <div key={step} className="flex items-center">
          <div className="flex flex-col items-center gap-1">
            <div
              className={`w-7 h-7 rounded-full border-2 flex items-center justify-center
                          text-xs font-mono font-bold transition-all ${
                            i < current
                              ? "border-brand-green bg-brand-green text-brand-black"
                              : i === current
                              ? "border-brand-green text-brand-green"
                              : "border-brand-border text-brand-muted"
                          }`}
            >
              {i < current ? "✓" : i + 1}
            </div>
            <span
              className={`text-xs whitespace-nowrap ${
                i <= current ? "text-brand-white" : "text-brand-muted"
              }`}
            >
              {step}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div
              className={`h-0.5 w-12 mx-1 mb-4 transition-all ${
                i < current ? "bg-brand-green" : "bg-brand-border"
              }`}
            />
          )}
        </div>
      ))}
    </div>
  );
}
