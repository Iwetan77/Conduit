"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";

// Local dev: app runs on :3000 (default `next dev` port, see packages/app's
// package.json) — `pnpm dev` at the repo root runs marketing/docs/app together
// via turbo. Production falls back to the real subdomain.
const APP_URL = process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000";

const NAV_LINKS = [
  { label: "Quickstart",  href: "/" },
  { label: "Guides",      href: "/guides" },
  { label: "Reference",   href: "/reference" },
  { label: "Dashboard →", href: `${APP_URL}/dashboard`, external: true },
];

export function DocNav() {
  const pathname = usePathname();

  return (
    <header
      className="fixed top-0 left-0 right-0 z-50 border-b border-border"
      style={{ background: "rgba(5,5,5,0.9)", backdropFilter: "blur(16px)" }}
    >
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5">
          <Image src="/CONDUIT-MAIN.png" alt="Conduit" height={38} width={120} style={{ height: 38, width: "auto" }} priority />
          <span className="font-mono text-[9px] text-ink-dim uppercase tracking-widest border border-border px-1.5 py-0.5">
            docs
          </span>
        </Link>

        <nav className="flex items-center gap-6">
          {NAV_LINKS.map(({ label, href, external }) => {
            const active = !external && (href === "/" ? pathname === "/" : pathname?.startsWith(href));
            return (
              <Link
                key={href}
                href={href}
                target={external ? "_blank" : undefined}
                rel={external ? "noopener noreferrer" : undefined}
                className={`font-mono text-[10px] uppercase tracking-[0.12em] transition-colors ${
                  active ? "text-signal" : "text-ink-dim hover:text-signal"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
