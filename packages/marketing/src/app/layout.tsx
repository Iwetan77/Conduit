import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Conduit — Arc's Native Agent Payment Protocol",
  description:
    "Paste an address. Share a link. Add one header. Conduit converts, routes, and settles — in any currency, in under a second.",
  keywords: ["payments", "stablecoin", "USDC", "EURC", "Arc", "agent payments", "x402"],
  openGraph: {
    title: "Conduit — Agent Payments, Reimagined",
    description: "Send any currency. Receive any currency. Settle in under a second on Arc Testnet.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Anton&family=Barlow+Condensed:ital,wght@0,700;0,800;0,900;1,900&family=Barlow:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
