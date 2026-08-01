"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";

// Docs live inside the app now (packages/docs is gone), so every link here
// is an ordinary in-app route — no cross-origin URL to configure.
const NAV_LINKS = [
  { label: "Quickstart",  href: "/docs" },
  { label: "Guides",      href: "/docs/guides" },
  { label: "Reference",   href: "/docs/reference" },
  { label: "Dashboard →", href: "/dashboard" },
];

export function DocNav() {
  const pathname = usePathname();

  return (
    <header
      className="fixed top-0 left-0 right-0 z-50 border-b border-border"
      style={{ background: "rgba(5,5,5,0.9)", backdropFilter: "blur(16px)" }}
    >
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <Link href="/docs" className="flex items-center gap-2.5">
          <Image src="/CONDUIT-MAIN.png" alt="Conduit" height={38} width={120} style={{ height: 38, width: "auto" }} priority />
          <span className="font-mono text-[9px] text-ink-dim uppercase tracking-widest border border-border px-1.5 py-0.5">
            docs
          </span>
        </Link>

        <nav className="flex items-center gap-6">
          {NAV_LINKS.map(({ label, href }) => {
            const active = href === "/docs" ? pathname === "/docs" : pathname?.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
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
