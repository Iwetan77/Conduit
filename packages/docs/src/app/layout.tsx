import type { Metadata } from "next";
import "./globals.css";
import { Anton, Barlow, IBM_Plex_Mono } from "next/font/google";
import { DocNav } from "@/components/DocNav";

const anton = Anton({ weight: "400", subsets: ["latin"], variable: "--font-anton" });
const barlow = Barlow({ weight: ["400", "500", "600"], subsets: ["latin"], variable: "--font-barlow" });
const mono = IBM_Plex_Mono({ weight: ["400", "500"], subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: { default: "Conduit Docs", template: "%s — Conduit Docs" },
  description:
    "Documentation for Conduit — accept any stablecoin, settle in yours. Quickstart, API reference, and webhook guides.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${anton.variable} ${barlow.variable} ${mono.variable}`}>
      <body>
        <DocNav />
        <div className="max-w-3xl mx-auto px-6 pt-24 pb-32">
          {children}
        </div>
      </body>
    </html>
  );
}
