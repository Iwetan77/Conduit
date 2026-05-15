"use client";

import Link from "next/link";
import Image from "next/image";

interface LogoProps {
  size?: "sm" | "md" | "lg";
  href?: string;
}

// Nav logo — the ⊙D mark icon (conduit-mainLogo)
const NAV_HEIGHTS = { sm: 48, md: 56, lg: 72 };

export function Logo({ size = "md", href = "/" }: LogoProps) {
  const h = NAV_HEIGHTS[size];
  const content = (
    <Image
      src="/CONDUIT-MAIN.png"
      alt="Conduit"
      height={h}
      width={h}
      style={{ height: h, width: "auto" }}
      priority
    />
  );

  if (href) {
    return <Link href={href} className="inline-block">{content}</Link>;
  }
  return <div className="inline-block">{content}</div>;
}

// Hero centrepiece — the CONDUIT wordmark (CONDUIT (1).png)
// The PNG has large black padding top/bottom; we crop it with objectFit:cover
// so only the actual text portion is visible.
export function ConduitMark({ height = 80 }: { height?: number; size?: number }) {
  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        maxWidth: 480,
        height: height,
        overflow: "hidden",
      }}
    >
      <Image
        src="/CONDUIT (1).png"
        alt="Conduit"
        fill
        style={{ objectFit: "cover", objectPosition: "center" }}
        priority
      />
    </div>
  );
}

// Wordmark only — footer / compact variant
export function Wordmark({ size = "sm" }: { size?: "sm" | "md" | "lg" }) {
  return <Logo size={size} href={undefined} />;
}
