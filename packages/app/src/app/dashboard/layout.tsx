"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { getApiKey, setApiKey, clearApiKey, createAccount } from "@/lib/conduit-api";

const NAV = [
  { href: "/dashboard/settlements", label: "Settlements" },
  { href: "/dashboard/request-payment", label: "Request payment" },
  { href: "/dashboard/locations", label: "Locations" },
  { href: "/dashboard/settings", label: "Settings" },
  { href: "/dashboard/developers", label: "Developers" },
  { href: "/dashboard/reconciliation", label: "Reconciliation" },
];

function OnboardingGate({ onReady }: { onReady: () => void }) {
  const [name, setName] = useState("");
  const [settleCurrency, setSettleCurrency] = useState("EUR");
  const [settleAddress, setSettleAddress] = useState("");
  const [pastedKey, setPastedKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const account = await createAccount({ name, settle_currency: settleCurrency, settle_address: settleAddress });
      if (!account.api_key) throw new Error("No API key returned");
      setApiKey(account.api_key.key);
      onReady();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create account");
    } finally {
      setBusy(false);
    }
  };

  const handleUseExisting = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pastedKey.trim()) return;
    setApiKey(pastedKey.trim());
    onReady();
  };

  return (
    <div className="min-h-screen bg-brand-black text-brand-white flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-8">
        <div>
          <h1 className="font-display text-3xl font-bold">Conduit Dashboard</h1>
          <p className="text-brand-muted text-sm mt-1">
            Create a test account to get started, or paste an existing sk_test_ key.
          </p>
        </div>

        <form onSubmit={handleCreate} className="space-y-3 border border-brand-border rounded-lg p-4">
          <h2 className="font-medium text-sm text-brand-muted">New account</h2>
          <input
            className="w-full bg-brand-surface border border-brand-border rounded px-3 py-2 text-sm"
            placeholder="Business name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <select
            className="w-full bg-brand-surface border border-brand-border rounded px-3 py-2 text-sm"
            value={settleCurrency}
            onChange={(e) => setSettleCurrency(e.target.value)}
          >
            {["EUR", "USD", "BRL", "AUD", "MXN", "CAD", "GBP", "ZAR", "KRW"].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <input
            className="w-full bg-brand-surface border border-brand-border rounded px-3 py-2 text-sm font-mono"
            placeholder="0x... settle address"
            value={settleAddress}
            onChange={(e) => setSettleAddress(e.target.value)}
            required
          />
          <button
            type="submit"
            disabled={busy}
            className="w-full bg-brand-green text-brand-black font-medium rounded py-2 text-sm disabled:opacity-50"
          >
            {busy ? "Creating..." : "Create account"}
          </button>
        </form>

        <form onSubmit={handleUseExisting} className="space-y-3 border border-brand-border rounded-lg p-4">
          <h2 className="font-medium text-sm text-brand-muted">Or use an existing key</h2>
          <input
            className="w-full bg-brand-surface border border-brand-border rounded px-3 py-2 text-sm font-mono"
            placeholder="sk_test_..."
            value={pastedKey}
            onChange={(e) => setPastedKey(e.target.value)}
          />
          <button type="submit" className="w-full border border-brand-border rounded py-2 text-sm">
            Use this key
          </button>
        </form>

        {error && <p className="text-red-400 text-sm">{error}</p>}
      </div>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [ready, setReady] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setReady(!!getApiKey());
  }, []);

  if (!mounted) return null;
  if (!ready) return <OnboardingGate onReady={() => setReady(true)} />;

  return (
    <div className="min-h-screen bg-brand-black text-brand-white flex">
      <aside className="w-56 border-r border-brand-border p-4 flex flex-col shrink-0">
        <Link href="/" className="font-display text-xl font-bold mb-8">Conduit</Link>
        <nav className="flex flex-col gap-1">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`px-3 py-2 rounded text-sm ${
                pathname?.startsWith(item.href)
                  ? "bg-brand-surface text-brand-green"
                  : "text-brand-muted hover:text-brand-white"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <button
          className="mt-auto text-xs text-brand-muted hover:text-brand-white text-left"
          onClick={() => {
            clearApiKey();
            setReady(false);
          }}
        >
          Sign out
        </button>
      </aside>
      <main className="flex-1 p-8 max-w-6xl">{children}</main>
    </div>
  );
}
