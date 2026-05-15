"use client";

import Link from "next/link";
import Image from "next/image";

interface LogoProps {
  size?: "sm" | "md" | "lg";
  href?: string;
}

const HEIGHTS = { sm: 32, md: 40, lg: 56 };

// Nav logo — the main wordmark image (conduit-mainLogo)
export function Logo({ size = "md", href = "/" }: LogoProps) {
  const h = HEIGHTS[size];
  // Preserve aspect ratio; width is auto via unset or a generous max
  const content = (
    <Image
      src="/conduit-mainLogo.svg.jpg"
      alt="Conduit"
      height={h}
      width={h * 4}   // wide enough for the wordmark; next/image will respect the natural ratio
      style={{ height: h, width: "auto" }}
      priority
    />
  );

  if (href) {
    return <Link href={href} className="inline-block">{content}</Link>;
  }
  return <div className="inline-block">{content}</div>;
}

// Hero centrepiece — the sub-logo / mark icon (conduit-sublogo)
export function ConduitMark({ size = 96 }: { size?: number }) {
  return (
    <Image
      src="/conduit-sublogo.svg.jpg"
      alt="Conduit"
      width={size}
      height={size}
      style={{ width: size, height: size, objectFit: "contain" }}
      priority
    />
  );
}

// Wordmark only — footer / compact variant
export function Wordmark({ size = "sm" }: { size?: "sm" | "md" | "lg" }) {
  return <Logo size={size} href={undefined} />;
}
