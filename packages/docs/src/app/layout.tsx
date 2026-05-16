import type { Metadata } from "next";
import "./globals.css";
import { DocNav } from "@/components/DocNav";

export const metadata: Metadata = {
  title: { default: "Conduit Docs", template: "%s — Conduit Docs" },
  description:
    "Documentation for Conduit — Arc's native agent payment protocol. Quickstart, Relay integration, and SDK reference.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;900&family=Barlow:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <DocNav />
        <div className="max-w-3xl mx-auto px-6 pt-24 pb-32">
          {children}
        </div>
      </body>
    </html>
  );
}
