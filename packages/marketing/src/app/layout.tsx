import type { Metadata } from "next";
import "./globals.css";
import { Anton, Barlow, IBM_Plex_Mono } from "next/font/google";

const anton = Anton({ weight: "400", subsets: ["latin"], variable: "--font-anton" });
const barlow = Barlow({ weight: ["400", "500", "600", "700"], subsets: ["latin"], variable: "--font-barlow" });
const mono = IBM_Plex_Mono({ weight: ["400", "500"], subsets: ["latin"], variable: "--font-mono" });

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
    <html lang="en" className={`${anton.variable} ${barlow.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
