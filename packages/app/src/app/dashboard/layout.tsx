"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePrivy, useLoginWithEmail } from "@privy-io/react-auth";
import { DashboardPrivyProvider } from "./dashboard-privy-provider";
import { clearSessionToken, createAccountFromPrivy, setSessionToken } from "@/lib/conduit-api";

// Signature moment: the major gridlines draw in once, here specifically —
// the dashboard is the main surface, not every page. Reuses the single
// global .conduit-grid element (rendered once in the root layout) rather
// than stacking a second grid layer; just replays its draw-in animation.
function GridSignature() {
  useEffect(() => {
    const grid = document.querySelector(".conduit-grid");
    if (!grid) return;
    grid.removeAttribute("data-animate");
    // Force reflow so re-adding the attribute restarts the CSS animation.
    void (grid as HTMLElement).offsetWidth;
    grid.setAttribute("data-animate", "true");
  }, []);
  return null;
}

const NAV = [
  { href: "/dashboard/settlements", label: "Settlements" },
  { href: "/dashboard/request-payment", label: "Request payment" },
  { href: "/dashboard/locations", label: "Locations" },
  { href: "/dashboard/settings", label: "Settings" },
  { href: "/dashboard/developers", label: "Developers" },
  { href: "/dashboard/reconciliation", label: "Reconciliation" },
];

// Email OTP login. Shown whenever Privy reports the merchant isn't
// authenticated yet. Only signs in with Privy -- account bootstrap happens
// separately in AccountGate once `authenticated` flips true, so this
// doesn't need to distinguish first-time vs. returning merchants.
function LoginGate() {
  const { sendCode, loginWithCode } = useLoginWithEmail();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await sendCode({ email });
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send code");
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await loginWithCode({ code });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid code");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg text-ink flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-8">
        <div>
          <h1 className="font-display text-3xl font-bold">Conduit Dashboard</h1>
          <p className="text-ink-dim text-sm mt-1">Sign in with your email to continue.</p>
        </div>

        {step === "email" && (
          <form onSubmit={handleSendCode} className="space-y-3 border border-border p-4">
            <input
              type="email"
              className="w-full bg-surface border border-border px-3 py-2 text-sm"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <button
              type="submit"
              disabled={busy}
              className="w-full bg-signal text-signal-ink font-medium py-2 text-sm disabled:opacity-50"
            >
              {busy ? "Sending..." : "Send code"}
            </button>
          </form>
        )}

        {step === "code" && (
          <form onSubmit={handleVerifyCode} className="space-y-3 border border-border p-4">
            <h2 className="font-medium text-sm text-ink-dim">Enter the code sent to {email}</h2>
            <input
              className="w-full bg-surface border border-border px-3 py-2 text-sm font-mono"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
            <button
              type="submit"
              disabled={busy}
              className="w-full bg-signal text-signal-ink font-medium py-2 text-sm disabled:opacity-50"
            >
              {busy ? "Verifying..." : "Verify"}
            </button>
          </form>
        )}

        {error && <p className="text-danger text-sm">{error}</p>}
      </div>
    </div>
  );
}

// Runs once Privy reports `authenticated`: resolves the Conduit account for
// this Privy user (idempotent -- existing merchants just get their account
// back). Falls back to an inline onboarding form only when the API reports
// no account exists yet for this Privy user (first-ever login).
function AccountGate({ onReady }: { onReady: () => void }) {
  const { user, getAccessToken } = usePrivy();
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [name, setName] = useState("");
  const [settleCurrency, setSettleCurrency] = useState("EUR");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const attempted = useRef(false);

  const bootstrap = async (extra?: { name: string; settle_currency: string }) => {
    const token = await getAccessToken();
    if (!token) throw new Error("No Privy access token");
    const loginWallet = user?.wallet?.address;
    if (!loginWallet) throw new Error("No embedded wallet on this Privy user yet");
    await createAccountFromPrivy(token, { login_wallet: loginWallet, ...extra });
    setSessionToken(token);
  };

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    (async () => {
      try {
        await bootstrap();
        onReady();
      } catch {
        setNeedsOnboarding(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleOnboard = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await bootstrap({ name, settle_currency: settleCurrency });
      onReady();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create account");
    } finally {
      setBusy(false);
    }
  };

  if (!needsOnboarding) return null;

  return (
    <div className="min-h-screen bg-bg text-ink flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-8">
        <div>
          <h1 className="font-display text-3xl font-bold">Conduit Dashboard</h1>
          <p className="text-ink-dim text-sm mt-1">First time here — set up your account.</p>
        </div>
        <form onSubmit={handleOnboard} className="space-y-3 border border-border p-4">
          <input
            className="w-full bg-surface border border-border px-3 py-2 text-sm"
            placeholder="Business name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <select
            className="w-full bg-surface border border-border px-3 py-2 text-sm"
            value={settleCurrency}
            onChange={(e) => setSettleCurrency(e.target.value)}
          >
            {["EUR", "USD", "BRL", "AUD", "MXN", "CAD", "GBP", "ZAR", "KRW"].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <button
            type="submit"
            disabled={busy}
            className="w-full bg-signal text-signal-ink font-medium py-2 text-sm disabled:opacity-50"
          >
            {busy ? "Creating..." : "Create account"}
          </button>
        </form>
        {error && <p className="text-danger text-sm">{error}</p>}
      </div>
    </div>
  );
}

function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { ready, authenticated, logout, getAccessToken } = usePrivy();
  const [accountReady, setAccountReady] = useState(false);
  const refreshing = useRef(false);

  // Keep the stored bearer token fresh with Privy's own (short-lived,
  // auto-rotated) access token for as long as the merchant stays on a
  // dashboard page -- every existing API call in this app reads it via
  // getSessionToken(), so this is the only place that needs to know Privy
  // issues the token.
  useEffect(() => {
    if (!authenticated) return;
    const refresh = async () => {
      if (refreshing.current) return;
      refreshing.current = true;
      try {
        const token = await getAccessToken();
        if (token) setSessionToken(token);
      } finally {
        refreshing.current = false;
      }
    };
    refresh();
    const interval = setInterval(refresh, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [authenticated, getAccessToken]);

  useEffect(() => {
    if (!authenticated) setAccountReady(false);
  }, [authenticated]);

  if (!ready) return null;
  if (!authenticated) return <LoginGate />;
  if (!accountReady) return <AccountGate onReady={() => setAccountReady(true)} />;

  const signOut = async () => {
    clearSessionToken();
    await logout();
  };

  return (
    <div className="min-h-screen bg-bg text-ink flex flex-col md:flex-row">
      <GridSignature />

      {/* Desktop sidebar — hidden below md, replaced by the horizontal strip below */}
      <aside className="hidden md:flex w-56 border-r border-border p-4 flex-col shrink-0">
        <Link href="/" className="font-display text-xl font-bold mb-8">Conduit</Link>
        <nav className="flex flex-col gap-1">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`px-3 py-2 text-sm ${
                pathname?.startsWith(item.href)
                  ? "bg-surface text-signal"
                  : "text-ink-dim hover:text-ink"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <button className="mt-auto text-xs text-ink-dim hover:text-ink text-left" onClick={signOut}>
          Sign out
        </button>
      </aside>

      {/* Mobile: horizontal scrollable nav strip instead of a sidebar */}
      <nav className="md:hidden flex items-center gap-1 border-b border-border px-3 py-2 overflow-x-auto shrink-0">
        <Link href="/" className="font-display text-base font-bold mr-2 shrink-0">Conduit</Link>
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`px-2.5 py-1.5 text-xs whitespace-nowrap shrink-0 ${
              pathname?.startsWith(item.href)
                ? "bg-surface text-signal"
                : "text-ink-dim hover:text-ink"
            }`}
          >
            {item.label}
          </Link>
        ))}
        <button className="ml-auto shrink-0 text-xs text-ink-dim hover:text-ink" onClick={signOut}>
          Sign out
        </button>
      </nav>

      <main className="flex-1 p-4 md:p-8 max-w-6xl overflow-x-hidden">{children}</main>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <DashboardPrivyProvider>
      <DashboardShell>{children}</DashboardShell>
    </DashboardPrivyProvider>
  );
}
