import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        // Graph-paper tokens — same names/values as packages/app and
        // packages/marketing. See CONDUIT design system spec.
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
      },
      fontFamily: {
        mono: ["var(--font-mono)", "monospace"],
        display: ["var(--font-anton)", "sans-serif"],
        anton: ["var(--font-anton)", "sans-serif"],
        body: ["var(--font-mono)", "monospace"],
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
    },
  },
  plugins: [],
};

export default config;
