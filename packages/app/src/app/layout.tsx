import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

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
      <body className="bg-brand-black text-brand-white font-body antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
