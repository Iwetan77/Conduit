import type { Metadata } from "next";
import "./globals.css";
import { Anton, JetBrains_Mono } from "next/font/google";

const anton = Anton({ weight: "400", subsets: ["latin"], variable: "--font-anton" });
const mono = JetBrains_Mono({ weight: ["400", "500", "600"], subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Conduit — Accept Any Stablecoin, Settle in Yours",
  description:
    "Accept any stablecoin, settle in yours. Conduit routes and settles B2B payments atomically, in under a second, on Arc.",
  keywords: ["payments", "stablecoin", "USDC", "EURC", "Arc", "B2B settlement", "FX"],
  openGraph: {
    title: "Conduit — Accept Any Stablecoin, Settle in Yours",
    description: "Conduit routes and settles B2B payments atomically, in under a second, on Arc.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${anton.variable} ${mono.variable}`}>
      <body className="font-mono">{children}</body>
    </html>
  );
}
