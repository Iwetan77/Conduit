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
        brand: {
          green: "#B2F55A",
          black: "#000000",
          white: "#FFFFFF",
          surface: "#111111",
          border: "#1F1F1F",
          muted: "#666666",
        },
      },
      fontFamily: {
        anton: ['"Anton"', "sans-serif"],
        display: ['"Barlow Condensed"', "sans-serif"],
        body: ['"Barlow"', "sans-serif"],
        mono: ['"IBM Plex Mono"', "monospace"],
      },
      fontSize: {
        "display-xl": ["5rem", { lineHeight: "1", letterSpacing: "-0.02em", fontWeight: "800" }],
        "display-lg": ["3.5rem", { lineHeight: "1.05", letterSpacing: "-0.02em", fontWeight: "800" }],
        "display-md": ["2.5rem", { lineHeight: "1.1", letterSpacing: "-0.01em", fontWeight: "700" }],
      },
      borderColor: {
        DEFAULT: "#1F1F1F",
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
