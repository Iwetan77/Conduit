"use client";

import Link from "next/link";
import Image from "next/image";

interface LogoProps {
  size?: "sm" | "md" | "lg";
  href?: string;
  showMark?: boolean;
}

// The Conduit wordmark: CON in #B2F55A, DUIT in #FFFFFF
// Logomark: /public/conduit-mark.svg — black circle, green left-circle, white D, black pipe
export function Logo({ size = "md", href = "/", showMark = false }: LogoProps) {
  const sizes = {
    sm: { text: "text-xl", mark: 28 },
    md: { text: "text-2xl", mark: 36 },
    lg: { text: "text-4xl", mark: 56 },
  };

  const wordmark = (
    <span
      className={`font-display font-black tracking-tight ${sizes[size].text} select-none`}
      style={{ letterSpacing: "-0.02em" }}
    >
      <span style={{ color: "#B2F55A" }}>CON</span>
      <span style={{ color: "#FFFFFF" }}>DUIT</span>
    </span>
  );

  const content = showMark ? (
    <div className="flex items-center gap-3">
      <ConduitMark size={sizes[size].mark} />
      {wordmark}
    </div>
  ) : wordmark;

  if (href) {
    return <Link href={href} className="inline-block">{content}</Link>;
  }
  return <div className="inline-block">{content}</div>;
}

// The logomark: loads from /public/conduit-mark.svg
export function ConduitMark({ size = 40 }: { size?: number }) {
  return (
    <Image
      src="/conduit-mark.svg"
      alt="Conduit"
      width={size}
      height={size}
      className="rounded-full"
    />
  );
}

// Wordmark only — footer variant
export function Wordmark({ size = "sm" }: { size?: "sm" | "md" | "lg" }) {
  return <Logo size={size} href={undefined} />;
}
