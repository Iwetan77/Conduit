"use client";

import Link from "next/link";
import Image from "next/image";

interface LogoProps {
  size?: "sm" | "md" | "lg";
  href?: string;
}

// Nav wordmark: CON (green) + DUIT (white) with a black stripe through the letters
// Matches the real Conduit brand identity
export function Logo({ size = "md", href = "/" }: LogoProps) {
  const textSizes = { sm: "text-2xl", md: "text-3xl", lg: "text-5xl" };

  const content = (
    <div className="relative inline-block select-none leading-none">
      <span
        className={`font-anton uppercase tracking-tight ${textSizes[size]}`}
        style={{ letterSpacing: "-0.01em" }}
      >
        <span style={{ color: "#B2F55A" }}>CON</span>
        <span style={{ color: "#FFFFFF" }}>DUIT</span>
      </span>
      {/* Black stripe cuts through the letters — same colour as header bg */}
      <div
        className="absolute inset-x-0 bg-black pointer-events-none"
        style={{ top: "36%", height: "19%", zIndex: 2 }}
      />
    </div>
  );

  if (href) {
    return (
      <Link href={href} className="inline-block">
        {content}
      </Link>
    );
  }
  return <div className="inline-block">{content}</div>;
}

// The ⊙D mark icon — used as the large hero centrepiece
export function ConduitMark({ size = 80 }: { size?: number }) {
  return (
    <Image
      src="/conduit-mark.svg"
      alt="Conduit"
      width={size}
      height={size}
      priority
    />
  );
}

// Wordmark only — footer / compact variant
export function Wordmark({ size = "sm" }: { size?: "sm" | "md" | "lg" }) {
  return <Logo size={size} href={undefined} />;
}
