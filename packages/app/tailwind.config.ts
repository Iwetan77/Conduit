import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Graph-paper tokens — same names/values as packages/marketing and
        // packages/docs. See CONDUIT design system spec.
        bg: "var(--bg)",
        "grid-line": "var(--grid-line)",
        "grid-line-lit": "var(--grid-line-lit)",
        surface: "var(--surface)",
        border: "var(--border)",
        ink: "var(--ink)",
        "ink-dim": "var(--ink-dim)",
        signal: "var(--signal)",
        "signal-ink": "var(--signal-ink)",
        danger: "var(--danger)",
        // Legacy brand-* aliases — kept so nothing breaks mid-migration.
        brand: {
          green: "var(--signal)",
          black: "var(--bg)",
          white: "var(--ink)",
          surface: "var(--surface)",
          border: "var(--border)",
          muted: "var(--ink-dim)",
        },
      },
      fontFamily: {
        anton: ['"Anton"', "sans-serif"],
        display: ['"Barlow Condensed"', "sans-serif"],
        body: ["var(--font-mono)", "ui-monospace", "monospace"],
        mono: ["var(--font-mono)", "ui-monospace", "SF Mono", "Menlo", "monospace"],
      },
      fontSize: {
        // Real type scale — 11/13/15/20/32/56, plus the existing display sizes.
        "scale-1": ["11px", { lineHeight: "1.4" }],
        "scale-2": ["13px", { lineHeight: "1.4" }],
        "scale-3": ["15px", { lineHeight: "1.5" }],
        "scale-4": ["20px", { lineHeight: "1.3" }],
        "scale-5": ["32px", { lineHeight: "1.1" }],
        "scale-6": ["56px", { lineHeight: "1" }],
        "display-xl": ["5rem", { lineHeight: "1", letterSpacing: "-0.02em", fontWeight: "800" }],
        "display-lg": ["3.5rem", { lineHeight: "1.05", letterSpacing: "-0.02em", fontWeight: "800" }],
        "display-md": ["2.5rem", { lineHeight: "1.1", letterSpacing: "-0.01em", fontWeight: "700" }],
      },
      borderRadius: {
        DEFAULT: "0",
        none: "0",
        sm: "0",
        md: "0",
        lg: "0",
        xl: "0",
        "2xl": "0",
        full: "0",
      },
      borderColor: {
        DEFAULT: "var(--border)",
      },
      animation: {
        "pulse-green": "pulse-green 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "slide-up": "slide-up 0.3s ease-out",
        "fade-in": "fade-in 0.2s ease-out",
      },
      keyframes: {
        "pulse-green": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.5" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(12px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
