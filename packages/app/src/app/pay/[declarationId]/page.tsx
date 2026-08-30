// Server Component wrapper for /pay/[declarationId]. Its ONLY job beyond
// rendering the client body is generateMetadata: fetching the public
// link/intent server-side so WhatsApp, X/Twitter, Telegram, iMessage etc. get
// a real preview card (merchant name + amount + branded image) instead of a
// bare URL. Crawlers never run JS, so this cannot live in the client component.
import type { Metadata } from "next";
import { toHumanAmount, currencyDecimals } from "@conduit/sdk/lite";
import { isoToToken } from "@/lib/currencies";
import { PayPageClient } from "./PayPageClient";

const API_BASE = process.env.NEXT_PUBLIC_CONDUIT_API_URL ?? "http://localhost:8080";

interface PublicInfo {
  display_name?: string;
  amount?: string; // minor units
  settle_currency?: string;
  description?: string;
}

// Fetch the payer-facing summary for either a payment_link (pl_) or a
// settlement_intent (si_). Best-effort: any failure just falls back to the
// generic Conduit card, never breaks the page.
async function fetchPublicInfo(id: string): Promise<PublicInfo | null> {
  const path = id.startsWith("pl_")
    ? `/v1/payment_links/${id}/public`
    : id.startsWith("si_")
      ? `/v1/settlement_intents/${id}/public`
      : null;
  if (!path) return null;
  try {
    const res = await fetch(`${API_BASE}${path}`, { next: { revalidate: 30 } });
    if (!res.ok) return null;
    return (await res.json()) as PublicInfo;
  } catch {
    return null;
  }
}

function formatMoney(minor: string | undefined, iso: string | undefined): string | null {
  if (!minor || !iso) return null;
  try {
    const token = isoToToken(iso);
    const human = toHumanAmount(BigInt(minor), currencyDecimals(token));
    const pretty = Number(human).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // Label with the token being transferred (EURC), not the merchant's ISO
    // settle currency (EUR) — the payer signs for the former.
    //
    // No fiat glyph in front of it. A "€" here named the currency EURC tracks,
    // then the token named the asset, so the share TITLE read "€200.00 EURC" —
    // the same doubling the card itself was fixed for. The table also had no
    // CHF entry, so CHFAU silently got none while EUR did.
    return `${pretty} ${token}`;
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ declarationId: string }>;
}): Promise<Metadata> {
  const { declarationId } = await params;
  const info = await fetchPublicInfo(declarationId);

  const merchant = info?.display_name?.trim();
  const money = formatMoney(info?.amount, info?.settle_currency);

  // Title: "Pay Acme — €200.00 EUR" when we have both; graceful degradation
  // as pieces are missing.
  const title = merchant
    ? money
      ? `Pay ${merchant} — ${money}`
      : `Pay ${merchant}`
    : "Pay with Conduit";
  const description =
    info?.description?.trim() ||
    (merchant
      ? `${merchant} is requesting a payment${money ? ` of ${money}` : ""} via Conduit. Pay with any stablecoin — settles instantly.`
      : "Pay with any stablecoin, settled instantly on Arc.");

  // Dynamic branded OG image lives alongside this route (opengraph-image.tsx);
  // Next.js wires it automatically, but we set twitter card type so X renders
  // the large image rather than a thumbnail.
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      siteName: "Conduit",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

export default async function PayPage({
  params,
}: {
  params: Promise<{ declarationId: string }>;
}) {
  const { declarationId } = await params;
  return <PayPageClient declarationId={declarationId} />;
}
