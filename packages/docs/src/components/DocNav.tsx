import Link from "next/link";
import Image from "next/image";

// Local dev: app runs on :3000 (default `next dev` port, see packages/app's
// package.json) — `pnpm dev` at the repo root runs marketing/docs/app together
// via turbo. Production falls back to the real subdomain.
const APP_URL = process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000";

const NAV_LINKS = [
  { label: "Quickstart",  href: "/" },
  { label: "Guides",      href: "/guides" },
  { label: "Relay",       href: "/relay" },
  { label: "Reference",   href: "/reference" },
  { label: "Dashboard →", href: `${APP_URL}/dashboard`, external: true },
];

export function DocNav() {
  return (
    <header
      className="fixed top-0 left-0 right-0 z-50 border-b"
      style={{ background: "rgba(0,0,0,0.9)", backdropFilter: "blur(16px)", borderColor: "#1F1F1F" }}
    >
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5">
          <Image src="/CONDUIT-MAIN.png" alt="Conduit" height={38} width={120} style={{ height: 38, width: "auto" }} priority />
          <span className="font-mono text-[9px] text-[#333] uppercase tracking-widest border border-[#1F1F1F] px-1.5 py-0.5 rounded">
            docs
          </span>
        </Link>

        <nav className="flex items-center gap-6">
          {NAV_LINKS.map(({ label, href, external }) => (
            <Link
              key={href}
              href={href}
              target={external ? "_blank" : undefined}
              rel={external ? "noopener noreferrer" : undefined}
              className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#555] hover:text-[#B2F55A] transition-colors"
            >
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
