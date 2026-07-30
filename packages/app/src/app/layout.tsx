import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { ChainGuard } from "@/components/Shared/ChainGuard";

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
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
    <html lang="en" className={jetbrainsMono.variable}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Anton&family=Barlow+Condensed:wght@700;800;900&family=Barlow:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-bg text-ink font-mono antialiased">
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
