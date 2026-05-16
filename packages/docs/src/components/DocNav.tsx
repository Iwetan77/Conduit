import Link from "next/link";

const NAV_LINKS = [
  { label: "Quickstart",  href: "/" },
  { label: "Relay",       href: "/relay" },
  { label: "Reference",   href: "/reference" },
  { label: "App →",       href: "https://app.conduit.xyz", external: true },
];

export function DocNav() {
  return (
    <header
      className="fixed top-0 left-0 right-0 z-50 border-b"
      style={{ background: "rgba(0,0,0,0.9)", backdropFilter: "blur(16px)", borderColor: "#1F1F1F" }}
    >
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <span className="font-display font-black text-lg leading-none tracking-tight">
            <span style={{ color: "#B2F55A" }}>CON</span>
            <span style={{ color: "#fff" }}>DUIT</span>
          </span>
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
