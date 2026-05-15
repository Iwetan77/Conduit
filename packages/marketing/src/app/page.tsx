import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Conduit — Arc's Native Agent Payment Protocol",
  description: "Send any currency. Receive any currency. Under a second. Built on Arc.",
};

export default function MarketingHome() {
  return (
    <main
      style={{
        background: "#000",
        color: "#fff",
        minHeight: "100vh",
        fontFamily: "Barlow, sans-serif",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px 24px",
        textAlign: "center",
      }}
    >
      {/* Wordmark */}
      <h1
        style={{
          fontFamily: "Barlow Condensed, sans-serif",
          fontWeight: 900,
          fontSize: "clamp(60px, 15vw, 120px)",
          letterSpacing: "-0.02em",
          lineHeight: 1,
          marginBottom: "24px",
        }}
      >
        <span style={{ color: "#B2F55A" }}>CON</span>
        <span style={{ color: "#fff" }}>DUIT</span>
        <span style={{ fontSize: "0.25em", verticalAlign: "super", color: "#666" }}>™</span>
      </h1>

      {/* Tagline */}
      <p
        style={{
          fontSize: "clamp(16px, 3vw, 24px)",
          color: "#666",
          maxWidth: "480px",
          lineHeight: 1.6,
          marginBottom: "48px",
        }}
      >
        Send any currency.
        <br />
        Receive any currency.
        <br />
        <span style={{ color: "#B2F55A" }}>Under a second.</span>
      </p>

      {/* Network badge */}
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "8px",
          padding: "8px 16px",
          borderRadius: "100px",
          border: "1px solid #1F1F1F",
          marginBottom: "40px",
          fontFamily: "IBM Plex Mono, monospace",
          fontSize: "12px",
          color: "#666",
        }}
      >
        <span
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            background: "#B2F55A",
          }}
        />
        Arc Testnet · Chain ID 5042002 · May 2026
      </div>

      {/* CTA */}
      <a
        href="https://app.conduit.xyz"
        style={{
          display: "inline-block",
          padding: "16px 40px",
          borderRadius: "12px",
          background: "#B2F55A",
          color: "#000",
          fontWeight: 700,
          fontSize: "18px",
          textDecoration: "none",
          marginBottom: "60px",
        }}
      >
        Open App →
      </a>

      {/* Feature grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "16px",
          maxWidth: "800px",
          width: "100%",
        }}
      >
        {[
          { title: "Direct Send", desc: "Paste address. Pick amount. Done." },
          { title: "Payment Links", desc: "Share a URL. Get paid in any token." },
          { title: "QR Codes", desc: "Print and laminate. For physical commerce." },
          { title: "SDK", desc: "conduit.pay(). For agents and developers." },
        ].map(({ title, desc }) => (
          <div
            key={title}
            style={{
              background: "#111",
              border: "1px solid #1F1F1F",
              borderRadius: "12px",
              padding: "20px",
              textAlign: "left",
            }}
          >
            <p style={{ fontWeight: 700, marginBottom: "6px", color: "#fff" }}>{title}</p>
            <p style={{ fontSize: "14px", color: "#666" }}>{desc}</p>
          </div>
        ))}
      </div>

      {/* Footer */}
      <footer
        style={{
          marginTop: "80px",
          color: "#333",
          fontSize: "12px",
          fontFamily: "IBM Plex Mono, monospace",
        }}
      >
        CONDUIT™ · Arc&apos;s Native Agent Payment Protocol · Chain ID 5042002
      </footer>
    </main>
  );
}
