import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
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
        // Legacy aliases — kept so nothing breaks mid-migration.
        green: "var(--signal)",
        muted: "var(--ink-dim)",
      },
      fontFamily: {
        display: ["var(--font-anton)", "sans-serif"],
        anton: ["var(--font-anton)", "sans-serif"],
        body: ["var(--font-mono)", "monospace"],
        mono: ["var(--font-mono)", "monospace"],
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
