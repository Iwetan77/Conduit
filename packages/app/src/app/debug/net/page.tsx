"use client";

// Throwaway browser-side network diagnostic. Payments fail with an opaque
// "Load failed" that only the user's mobile browser sees -- this runs the exact
// fetches a payment makes (API health, the Arc RPC proxy, a DB-backed
// endpoint) FROM the browser and shows which one fails and the real error, so
// the failure can be pinpointed instead of guessed. Safe: read-only calls, no
// keys, no funds. Delete once the issue is found.
import { useState } from "react";

const API = process.env.NEXT_PUBLIC_CONDUIT_API_URL ?? "";
const RPC = process.env.NEXT_PUBLIC_ARC_RPC_URL ?? "";

interface Row {
  label: string;
  ok: boolean;
  detail: string;
  ms: number;
}

export default function NetDebug() {
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    setRows([]);
    const out: Row[] = [];
    const step = async (label: string, fn: () => Promise<string>) => {
      const t0 = performance.now();
      try {
        const detail = await fn();
        out.push({ label, ok: true, detail, ms: Math.round(performance.now() - t0) });
      } catch (e) {
        out.push({
          label,
          ok: false,
          detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
          ms: Math.round(performance.now() - t0),
        });
      }
      setRows([...out]);
    };

    await step("API /healthz (GET)", async () => {
      const r = await fetch(`${API}/healthz`);
      return `HTTP ${r.status}`;
    });
    await step("RPC proxy eth_chainId (POST)", async () => {
      const r = await fetch(RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      const j = await r.json();
      return `HTTP ${r.status} → ${j.result ?? JSON.stringify(j.error)}`;
    });
    await step("RPC proxy eth_getTransactionCount (POST)", async () => {
      const r = await fetch(RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getTransactionCount",
          params: ["0xa2b699f3f683afb958358a6868f76fcdf6626bb9", "latest"],
        }),
      });
      const j = await r.json();
      return `HTTP ${r.status} → ${j.result ?? JSON.stringify(j.error)}`;
    });
    await step("API /v1/currencies (GET, DB)", async () => {
      const r = await fetch(`${API}/v1/currencies`);
      return `HTTP ${r.status}`;
    });

    setRunning(false);
  };

  const box: React.CSSProperties = {
    padding: 20,
    fontFamily: "monospace",
    color: "#ddd",
    background: "#050505",
    minHeight: "100vh",
  };

  return (
    <div style={box}>
      <h1 style={{ color: "#B2F55A", fontSize: 20 }}>Network Diagnostic</h1>
      <p style={{ fontSize: 12, wordBreak: "break-all" }}>
        API: <b style={{ color: API ? "#9f9" : "#f55" }}>{API || "(EMPTY!)"}</b>
      </p>
      <p style={{ fontSize: 12, wordBreak: "break-all" }}>
        RPC: <b style={{ color: RPC ? "#9f9" : "#f55" }}>{RPC || "(EMPTY!)"}</b>
      </p>
      <button
        onClick={run}
        disabled={running}
        style={{
          padding: "12px 20px",
          background: "#B2F55A",
          color: "#000",
          border: 0,
          fontWeight: 700,
          margin: "14px 0",
          fontFamily: "monospace",
        }}
      >
        {running ? "Running…" : "Run test"}
      </button>
      {rows.map((r, i) => (
        <div
          key={i}
          style={{
            padding: 10,
            borderLeft: `3px solid ${r.ok ? "#B2F55A" : "#ff5a5a"}`,
            marginBottom: 8,
            background: "#111",
            fontSize: 12,
          }}
        >
          <div>
            {r.ok ? "✓" : "✗"} {r.label} <span style={{ color: "#888" }}>({r.ms}ms)</span>
          </div>
          <div style={{ color: r.ok ? "#9f9" : "#f99", wordBreak: "break-all", marginTop: 4 }}>
            {r.detail}
          </div>
        </div>
      ))}
    </div>
  );
}
