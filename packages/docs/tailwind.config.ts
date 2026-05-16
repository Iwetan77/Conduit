import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        green: "#B2F55A",
        surface: "#111111",
        border: "#1F1F1F",
        muted: "#555555",
      },
      fontFamily: {
        mono: ["IBM Plex Mono", "monospace"],
        display: ["Barlow Condensed", "sans-serif"],
        body: ["Barlow", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
