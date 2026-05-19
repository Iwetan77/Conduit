import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { ChainGuard } from "@/components/Shared/ChainGuard";

export const metadata: Metadata = {
  title: "Conduit — Arc Native Agent Payment Protocol",
  description:
    "Send any currency, receive any currency. Conduit routes and settles atomically in under a second on Arc Testnet.",
  keywords: ["payments", "stablecoin", "USDC", "EURC", "Arc", "blockchain", "agent payments"],
  openGraph: {
    title: "Conduit",
    description: "Arc's native agent payment protocol",
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
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Anton&family=Barlow+Condensed:wght@700;800;900&family=Barlow:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-brand-black text-brand-white font-body antialiased">
        <Providers>
          <ChainGuard>
            {children}
          </ChainGuard>
        </Providers>
      </body>
    </html>
  );
}
