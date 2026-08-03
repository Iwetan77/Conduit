import type { Metadata } from "next";
// Self-hosted fonts (no render-blocking fonts.googleapis.com round-trips,
// no build-time Google Fonts fetch that fails offline).
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/anton/400.css";
import "@fontsource/barlow-condensed/700.css";
import "@fontsource/barlow-condensed/800.css";
import "@fontsource/barlow-condensed/900.css";
import "./globals.css";
import { Providers } from "./providers";
import { ChainGuard } from "@/components/Shared/ChainGuard";

export const metadata: Metadata = {
  // Makes relative OG image URLs (e.g. the per-link /pay/[id]/opengraph-image)
  // resolve to absolute ones so crawlers can fetch them. Falls back to the
  // Vercel-provided deploy URL, then localhost for dev.
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ??
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000")
  ),
  title: "Conduit — Accept Any Stablecoin, Settle in Yours",
  description:
    "Accept any stablecoin, settle in yours. Conduit routes and settles atomically in under a second on Arc Testnet.",
  keywords: ["payments", "stablecoin", "USDC", "EURC", "Arc", "blockchain", "B2B settlement"],
  openGraph: {
    title: "Conduit",
    description: "Accept any stablecoin, settle in yours.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      {/* No bg on body — an opaque body background paints over the
          z-index:-1 grid. The canvas bg comes from html (globals.css). */}
      <body className="text-ink font-mono antialiased">
        {/* Static grid, always rendered. The one-time draw-in signature moment
            is dashboard-specific (see dashboard/layout.tsx), not app-wide. */}
        <div className="conduit-grid" aria-hidden="true" />
        <Providers>
          <ChainGuard>
            {children}
          </ChainGuard>
        </Providers>
      </body>
    </html>
  );
}
