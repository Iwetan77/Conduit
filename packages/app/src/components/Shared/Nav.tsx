"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "./Logo";
import { WalletConnect } from "./WalletConnect";

const NAV_LINKS = [
  { href: "/", label: "Send" },
  { href: "/create", label: "Create" },
  { href: "/links", label: "Links" },
  { href: "/history", label: "History" },
];


export function Nav() {
  const pathname = usePathname();

  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b border-brand-border bg-brand-black/90 backdrop-blur-sm">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <Logo size="sm" />

        <nav className="hidden md:flex items-center gap-1">
          {NAV_LINKS.map(({ href, label }) => {
            const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`px-3 py-1.5 rounded-lg text-sm font-mono tracking-wider transition-colors ${
                  isActive
                    ? "text-brand-white bg-brand-surface"
                    : "text-brand-muted hover:text-brand-white"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </nav>

        <WalletConnect />
      </div>
    </header>
  );
}

export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-brand-border bg-brand-black/95 backdrop-blur-sm md:hidden">
      <div className="flex">
        {NAV_LINKS.map(({ href, label }) => {
          const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`flex-1 py-3 text-center text-xs font-mono tracking-wider transition-colors ${
                isActive ? "text-brand-green" : "text-brand-muted"
              }`}
            >
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
