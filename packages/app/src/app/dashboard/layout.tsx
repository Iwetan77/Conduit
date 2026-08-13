"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePrivy, useLogin, useCreateWallet } from "@privy-io/react-auth";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import {
  clearSessionToken,
  createAccountFromCircle,
  createAccountFromPrivy,
  setSessionToken,
} from "@/lib/conduit-api";
import { CIRCLE_CONNECTOR_ID } from "@/lib/circle/connector";
import { clearCircleSession, currentSession } from "@/lib/circle/browser";
import { SETTLE_CURRENCIES, settleCurrencyLabel } from "@/lib/currencies";
import { Logo } from "@/components/Shared/Logo";
import { PaymentToasts } from "@/components/Dashboard/PaymentToasts";

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

// Ordered by how a merchant actually works: see what came in (Settlements),
// then the three ways to get paid grouped together — Request payment,
// Storefronts (per-location QR sub-accounts, formerly "Locations"), Links &
// invoices — then Send, then the admin surfaces. Storefronts sits right after
// Request payment because it's a collect-payment tool, not an afterthought
// buried below Send.
const NAV = [
  { href: "/dashboard/settlements", label: "Settlements" },
  { href: "/dashboard/request-payment", label: "Request payment" },
  { href: "/dashboard/locations", label: "Storefronts" },
  { href: "/dashboard/links", label: "Links & invoices" },
  { href: "/dashboard/send", label: "Send" },
  { href: "/dashboard/reconciliation", label: "Reconciliation" },
  { href: "/dashboard/developers", label: "Developers" },
  { href: "/dashboard/settings", label: "Settings" },
];

// The same ordering, split into the three jobs a merchant actually switches
// between. An unbroken list of eight links gives no sense of where you are in
// the product; labelled groups make the sidebar readable at a glance.
const NAV_GROUPS = [
  { label: "Money in", items: NAV.slice(0, 4) },
  { label: "Money out", items: NAV.slice(4, 5) },
  { label: "Admin", items: NAV.slice(5) },
];

// Who you're signed in as. The dashboard never said, so a merchant running
// more than one account had no way to tell which one they were about to create
// a payment link under.
function MerchantIdentity() {
  const [name, setName] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    import("@/lib/conduit-api")
      .then(({ getMyAccount }) => getMyAccount())
      .then((a) => { if (!cancelled) setName(a.name); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="flex items-center gap-2.5 border border-border bg-surface px-3 py-2.5 mb-6">
      <div className="w-7 h-7 shrink-0 bg-signal/15 border border-signal/30 flex items-center justify-center font-display font-bold text-signal text-sm">
        {name ? name.charAt(0).toUpperCase() : " "}
      </div>
      <div className="min-w-0">
        <p className="text-ink text-xs font-medium truncate">{name || "Loading..."}</p>
        <p className="text-ink-dim text-[10px] font-mono uppercase tracking-wider">Merchant</p>
      </div>
    </div>
  );
}

// Opens Privy's own login modal (configured with loginMethods: ['email',
// 'google'] in the root Providers) rather than a custom in-page form --
// this is what actually gives merchants a choice between Google (skips the
// OTP step entirely) and email OTP in one place, themed dark/green via the
// same `appearance` config. Account bootstrap happens separately in
// AccountGate once `authenticated` flips true.
function LoginGate() {
  const { login } = useLogin();

  return (
    <div className="min-h-screen text-ink flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-8 text-center">
        <div>
          <h1 className="font-display text-3xl font-bold">Conduit Dashboard</h1>
          <p className="text-ink-dim text-sm mt-1">Sign in to continue.</p>
        </div>
        <button
          onClick={() => login()}
          className="w-full bg-signal text-signal-ink font-medium py-2 text-sm"
        >
          Sign in
        </button>
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
  const { createWallet } = useCreateWallet();
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [name, setName] = useState("");
  const [settleCurrency, setSettleCurrency] = useState("EUR");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const attempted = useRef(false);

  // The embedded wallet from `embeddedWallets: { ethereum: { createOnLogin:
  // 'users-without-wallets' } }` isn't always present on `user` the instant
  // `authenticated` flips true -- creation can still be in flight. Try
  // creating one explicitly; if it already exists, createWallet() rejects
  // and the address is already on `user.wallet` by then.
  const ensureLoginWallet = async (): Promise<string> => {
    if (user?.wallet?.address) return user.wallet.address;
    try {
      const wallet = await createWallet();
      return wallet.address;
    } catch {
      if (user?.wallet?.address) return user.wallet.address;
      throw new Error("No embedded wallet on this Privy user yet");
    }
  };

  const bootstrap = async (extra?: { name: string; settle_currency: string }) => {
    const token = await getAccessToken();
    if (!token) throw new Error("No Privy access token");
    const loginWallet = await ensureLoginWallet();
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
    <div className="min-h-screen text-ink flex items-center justify-center p-6">
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
            {SETTLE_CURRENCIES.map((c) => (
              <option key={c} value={c}>{settleCurrencyLabel(c)}</option>
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

// The dashboard chrome, with no identity provider in it.
//
// Extracted so Privy and Circle can share it. The alternative -- a second
// copy of the sidebar, nav and mobile menu behind a flag -- would drift the
// moment either one is edited, and the whole point of this migration is that
// swapping the provider does not mean rewriting the app around it.
function DashboardChrome({
  children,
  signOut,
}: {
  children: React.ReactNode;
  signOut: () => void | Promise<void>;
}) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  // Any navigation closes the mobile menu — otherwise it stayed open on top
  // of the page the merchant just tapped through to.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  return (
    <div className="min-h-screen text-ink flex flex-col md:flex-row">
      <GridSignature />

      {/* Desktop sidebar — hidden below md, replaced by the hamburger bar below.
          The brand is the ⊙D logo mark, not the word "Conduit". */}
      <aside className="hidden md:flex w-60 border-r border-border p-4 flex-col shrink-0">
        {/* Logo renders its own <Link href="/">. Wrapping it in another one
            nests <a> inside <a>, which is invalid HTML and fails hydration. */}
        <div className="inline-block mb-6"><Logo size="sm" /></div>
        <MerchantIdentity />
        <nav className="flex flex-col gap-6">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="flex flex-col gap-0.5">
              <p className="text-[10px] font-mono text-ink-dim/70 uppercase tracking-widest px-3 mb-1.5">
                {group.label}
              </p>
              {group.items.map((item) => {
                const active = pathname?.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    // The active item carries a solid signal bar on its leading
                    // edge. A colour change alone was easy to miss against the
                    // dark grid, so the current page never announced itself.
                    className={`relative px-3 py-2 text-sm transition-colors ${
                      active
                        ? "bg-surface text-signal font-medium"
                        : "text-ink-dim hover:text-ink hover:bg-surface/50"
                    }`}
                  >
                    {active && (
                      <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-signal" />
                    )}
                    {item.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="mt-auto pt-6">
          <div className="h-px bg-border mb-3" />
          <button className="text-xs text-ink-dim hover:text-ink text-left" onClick={signOut}>
            Sign out
          </button>
        </div>
      </aside>

      {/* Mobile: a proper top bar with a hamburger, not a cramped horizontal
          scroll strip that hid half the items off-screen. The menu opens as a
          full-width panel below the bar. */}
      <div className="md:hidden flex flex-col border-b border-border shrink-0">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="inline-block"><Logo size="sm" /></div>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            className="p-2 -mr-2 text-ink hover:text-signal transition-colors"
          >
            {/* Hamburger / close, drawn so it can't drift from theme colors. */}
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
              {menuOpen ? (
                <path d="M4 4l14 14M18 4L4 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              ) : (
                <>
                  <path d="M3 6h16M3 11h16M3 16h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </>
              )}
            </svg>
          </button>
        </div>

        {menuOpen && (
          <nav className="flex flex-col border-t border-border">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`px-4 py-3 text-sm border-b border-border/60 last:border-0 ${
                  pathname?.startsWith(item.href)
                    ? "bg-surface text-signal"
                    : "text-ink-dim hover:text-ink"
                }`}
              >
                {item.label}
              </Link>
            ))}
            <button
              className="px-4 py-3 text-sm text-left text-ink-dim hover:text-ink border-t border-border"
              onClick={signOut}
            >
              Sign out
            </button>
          </nav>
        )}
      </div>

      {/* mx-auto centres the capped content column in the space left of the
          sidebar. Without it the column was pinned to the sidebar's edge, so on
          a wide screen every page sat hard left with a large dead area to the
          right — most obvious on the narrow forms, which now centre within it. */}
      <main className="flex-1 p-4 md:p-8 max-w-6xl mx-auto w-full overflow-x-hidden">{children}</main>
      {/* Lives in the shell, not on a page: a payment landing is worth seeing
          whichever dashboard screen the merchant happens to be on. */}
      <PaymentToasts />
    </div>
  );
}

// Privy identity. Unchanged behaviour; it just renders the shared chrome now.
function PrivyDashboard({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, logout, getAccessToken } = usePrivy();
  const queryClient = useQueryClient();
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
    // Drop every cached query too. Without this, a second merchant signing
    // in on the same machine could be served the previous merchant's cached
    // data before their own request resolves.
    queryClient.clear();
    try {
      localStorage.removeItem("conduit.lastMerchant");
    } catch {}
    await logout();
  };
  return <DashboardChrome signOut={signOut}>{children}</DashboardChrome>;
}


// The sign-in screen for a Circle merchant.
//
// A separate component from LoginGate rather than a flag inside it: LoginGate
// calls Privy's useLogin(), and under the Circle flag there is no Privy
// provider mounted for that hook to reach. It does not throw -- it simply
// returns a login() that does nothing, so the button rendered fine and clicked
// into the void.
function CircleLoginGate() {
  const { connect, connectors, isPending } = useConnect();
  const [error, setError] = useState("");
  const circle = connectors.find((c) => c.id === CIRCLE_CONNECTOR_ID);

  return (
    <div className="min-h-screen text-ink flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-8 text-center">
        <div>
          <h1 className="font-display text-3xl font-bold">Conduit Dashboard</h1>
          <p className="text-ink-dim text-sm mt-1">Sign in to continue.</p>
        </div>
        <button
          onClick={() => {
            if (!circle) {
              setError("Circle sign-in is not configured on this build.");
              return;
            }
            connect({ connector: circle });
          }}
          disabled={isPending || !circle}
          className="w-full bg-signal text-signal-ink font-medium py-2 text-sm disabled:opacity-50"
        >
          {isPending ? "Opening Google…" : "Sign in with Google"}
        </button>
        {error && <p className="text-danger text-sm">{error}</p>}
      </div>
    </div>
  );
}

// Circle identity, via the wagmi connector.
//
// Much shorter than the Privy version, and not because corners were cut: the
// connector already carries the session, so there is no separate access token
// to keep refreshing and no embedded wallet to wait on. The wallet address IS
// the connected account.
function CircleDashboard({ children }: { children: React.ReactNode }) {
  const { address, isConnected, connector } = useAccount();
  const { disconnectAsync } = useDisconnect();
  const queryClient = useQueryClient();
  const [accountReady, setAccountReady] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const onCircle = isConnected && connector?.id === CIRCLE_CONNECTOR_ID;

  // Resolve (or create) the Conduit account for this Circle identity.
  useEffect(() => {
    if (!onCircle || !address) {
      setAccountReady(false);
      return;
    }
    const s = currentSession();
    if (!s) return;
    let cancelled = false;
    (async () => {
      try {
        const account = await createAccountFromCircle(s.userToken, { login_wallet: address });
        // From here on the app authenticates with Conduit's own session, not
        // Circle's token — one local check per request instead of a round trip
        // to Circle.
        if (account.session_token) setSessionToken(account.session_token);
        if (!cancelled) setAccountReady(true);
      } catch {
        // A first-ever login has no name/settle currency yet, which the server
        // requires. That is onboarding, not an error.
        if (!cancelled) setNeedsOnboarding(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onCircle, address]);

  const signOut = async () => {
    clearSessionToken();
    queryClient.clear();
    try {
      localStorage.removeItem("conduit.lastMerchant");
    } catch {}
    await disconnectAsync();
    clearCircleSession();
  };

  if (!onCircle) return <CircleLoginGate />;
  if (needsOnboarding) {
    return (
      <CircleOnboarding
        address={address!}
        onDone={() => {
          setNeedsOnboarding(false);
          setAccountReady(true);
        }}
      />
    );
  }
  if (!accountReady) return null;
  return <DashboardChrome signOut={signOut}>{children}</DashboardChrome>;
}

// First-login onboarding for a Circle merchant. Same required fields as the
// Privy path -- the server rejects an account without them, and an account
// with no settle currency is one nothing can be paid into.
function CircleOnboarding({ address, onDone }: { address: string; onDone: () => void }) {
  const [name, setName] = useState("");
  const [settleCurrency, setSettleCurrency] = useState("USD");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const s = currentSession();
      if (!s) throw new Error("No Circle session");
      const account = await createAccountFromCircle(s.userToken, {
        name,
        settle_currency: settleCurrency,
        login_wallet: address,
      });
      if (account.session_token) setSessionToken(account.session_token);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        <h1 className="font-display text-xl font-bold text-ink">Create your account</h1>
        <form onSubmit={submit} className="space-y-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Business name"
            required
            className="w-full bg-surface border border-border p-2 text-sm text-ink"
          />
          <select
            value={settleCurrency}
            onChange={(e) => setSettleCurrency(e.target.value)}
            className="w-full bg-surface border border-border p-2 text-sm text-ink"
          >
            {SETTLE_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {settleCurrencyLabel(c)}
              </option>
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

// Which identity provider the dashboard runs on. Defaults to privy, so an
// unset variable leaves the merchant experience byte-for-byte unchanged.
//
// A switch rather than a choice made per-component: the two cannot share a
// wagmi config (see app/providers.tsx), so the whole dashboard runs on one or
// the other.
const CIRCLE_AUTH = process.env.NEXT_PUBLIC_AUTH_PROVIDER === "circle";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  if (CIRCLE_AUTH) return <CircleDashboard>{children}</CircleDashboard>;
  return <PrivyDashboard>{children}</PrivyDashboard>;
}
