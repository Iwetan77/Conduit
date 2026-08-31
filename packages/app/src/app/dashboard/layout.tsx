"use client";

import { useMyAccount } from "@/lib/queries";
import { SettlementWalletProvisioner } from "@/components/Dashboard/SettlementWalletProvisioner";
import { signOutCompletely } from "@/lib/sign-out";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useConnect } from "wagmi";
import {
  clearSessionToken,
  createAccountFromCircle,
  logout,
  setSessionToken,
} from "@/lib/conduit-api";
import { CIRCLE_CONNECTOR_ID } from "@/lib/circle/connector";
import { useCircleAccount } from "@/lib/circle/connection";
import {
  clearCircleSession,
  currentSession,
  hasPendingResume,
  hasPersistedSession,
  restoreSession,
} from "@/lib/circle/browser";
import { SettleCurrencySelect } from "@/components/Shared/SettleCurrencySelect";
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
  { href: "/dashboard/employees", label: "Employees" },
  { href: "/dashboard/payroll", label: "Payroll" },
  { href: "/dashboard/reconciliation", label: "Reconciliation" },
  { href: "/dashboard/developers", label: "Developers" },
  { href: "/dashboard/settings", label: "Settings" },
];

// The same ordering, split into the three jobs a merchant actually switches
// between. An unbroken list of eight links gives no sense of where you are in
// the product; labelled groups make the sidebar readable at a glance.
const NAV_GROUPS = [
  { label: "Money in", items: NAV.slice(0, 4) },
  { label: "Money out", items: NAV.slice(4, 7) },
  { label: "Admin", items: NAV.slice(7) },
];

// Who you're signed in as. The dashboard never said, so a merchant running
// more than one account had no way to tell which one they were about to create
// a payment link under.
function MerchantIdentity() {
  // Through the shared cache, not its own fetch.
  //
  // This mounted on EVERY dashboard page and refetched the account each time,
  // so the merchant's own business name flickered to "Loading..." on every
  // click. It also raced the identical call made by the page below it --
  // /dashboard/settlements, /request-payment and /settings each fetched the
  // same account concurrently with this one, and nothing deduped them. One key
  // with a five minute staleTime collapses all of that into a single request
  // for the session.
  const { data: account } = useMyAccount();
  const name = account?.name ?? "";

  return (
    <div className="flex items-center gap-2.5 border border-border bg-surface px-3 py-2.5 mb-6">
      <div className="w-7 h-7 shrink-0 bg-signal/15 border border-signal/30 flex items-center justify-center font-display font-bold text-signal text-sm">
        {name ? name.charAt(0).toUpperCase() : " "}
      </div>
      <div className="min-w-0">
        {/* A reserved line rather than the word "Loading...", which used to
              appear on every navigation. */}
          <p className="text-ink text-xs font-medium truncate">
            {name || <span className="inline-block h-3 w-24 bg-border align-middle" aria-hidden />}
          </p>
        <p className="text-ink-dim text-[10px] font-mono uppercase tracking-wider">Merchant</p>
      </div>
    </div>
  );
}


// LoginGate and AccountGate lived here and were Privy-only. Both are gone with
// Privy; CircleLoginGate and CircleOnboarding below are their replacements.
//
// Worth recording what AccountGate had to do that the Circle path does not.
// Privy's embedded wallet was not reliably present on `user` the instant
// `authenticated` flipped true -- creation could still be in flight -- so it
// carried an ensureLoginWallet() that called createWallet() and swallowed the
// rejection that meant "one already exists". A Circle session cannot exist
// without its wallets: restoreSession() resolves them before the session is
// published, so `address` is always real by the time anything reads it.

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

  // The page behind a covering menu must not scroll with it. Without this the
  // menu is a fixed layer over a document that still responds to the swipe,
  // so closing it lands the merchant somewhere they never scrolled to.
  useEffect(() => {
    if (!menuOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [menuOpen]);

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
          scroll strip that hid half the items off-screen.

          The open menu covers the page rather than pushing it down. In flow it
          simply added itself above the content, so the page it was covering
          scrolled along underneath and the two read as one column of stacked
          text -- nav items sitting on top of the Settlements page, with no
          sense of which layer you were looking at. Fixed and full-height makes
          it a surface you are either in or out of. */}
      <div
        className={`md:hidden flex flex-col border-b border-border shrink-0 bg-bg ${
          menuOpen ? "fixed inset-0 z-50 overflow-y-auto" : ""
        }`}
      >
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

// PrivyDashboard stood here. It did one thing CircleDashboard does not have to:
// re-fetch Privy's short-lived access token every five minutes and store it as
// the bearer, because verifying it meant a network call to Privy on every API
// request. The Conduit session token replaced that -- minted once at sign-in,
// HMAC-verified locally, no refresh loop.

// The sign-in screen for a Circle merchant.
//
// This began as a separate component from Privy's LoginGate, because that one
// called useLogin() and, with no Privy provider mounted, the hook did not throw
// -- it returned a login() that did nothing, so the button rendered perfectly
// and clicked into the void. Now the only sign-in screen there is.
function CircleLoginGate() {
  const { connect, connectors, isPending } = useConnect();
  const [error, setError] = useState("");
  const circle = connectors.find((c) => c.id === CIRCLE_CONNECTOR_ID);
  // Where they were going. Somebody who clicked a payroll link and landed on a
  // sign-in screen saying only "Sign in to continue" has lost the thread of
  // what they were doing; naming the destination keeps it.
  const pathname = usePathname();
  const destination = NAV.find((n) => pathname?.startsWith(n.href))?.label;

  return (
    <div className="min-h-screen text-ink flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-8 text-center">
        <div>
          <h1 className="font-display text-3xl font-bold">
            {destination ?? "Conduit Dashboard"}
          </h1>
          <p className="text-ink-dim text-sm mt-1">
            {destination ? `Sign in to see ${destination}.` : "Sign in to continue."}
          </p>
        </div>
        <button
          onClick={() => {
            if (!circle) {
              setError("Circle sign-in is not configured on this build.");
              return;
            }
            connect({ connector: circle });
          }}
          // NOT disabled on isPending. connect() deliberately never settles --
          // the page is navigating to Google -- so isPending stays true for the
          // life of the document. Gating the button on it left the only way in
          // permanently unclickable.
          disabled={!circle}
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
  // The CIRCLE connection, not wagmi's "current" one.
  //
  // This gate used to read useAccount(), which answers for whichever connector
  // is current — so a merchant who also had a wallet extension installed was
  // shown the sign-in screen on every dashboard page, over a live session,
  // because the extension had reattached itself first at page load and taken
  // the current slot. lib/circle/connection has the full mechanism.
  const { address, connected: onCircle } = useCircleAccount();
  const queryClient = useQueryClient();
  const [accountReady, setAccountReady] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  // Declared with the other hooks, above every early return below.
  //
  // Not moved down next to the gate it feeds, however tempting that reads: a
  // hook placed after a conditional return is exactly the shape that took the
  // whole site down with React #310 twice, and this component returns early
  // five times. Enabled only once the account exists, so it costs nothing on
  // the sign-in and onboarding screens.
  const { data: myAccount } = useMyAccount(accountReady);

  // Is a sign-in still being resolved?
  //
  // Reattaching a stored session is asynchronous -- it builds the SDK and
  // re-validates the token against Circle -- and wagmi reports "not connected"
  // for the whole of that. Rendering the sign-in screen on that meant every
  // reload of an authenticated page flashed "Sign in to continue" at a merchant
  // who was already signed in, on the way to the page they asked for. It looked
  // like being signed out and then rescued.
  //
  // Starts false and is set in an effect on purpose: the answer comes from
  // localStorage, which does not exist during prerender, so reading it while
  // rendering would make the server and client disagree.
  const [resolvingSession, setResolvingSession] = useState(false);
  useEffect(() => {
    if (!hasPendingResume() && !hasPersistedSession()) return;
    setResolvingSession(true);
    let cancelled = false;
    // Memoised inside the module -- this joins the restore the connector's
    // setup() already started rather than beginning a second one.
    restoreSession()
      .catch(() => null)
      .finally(() => {
        if (!cancelled) setResolvingSession(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  // One implementation, shared with the nav's button. These were two copies
  // that drifted: this one did the whole job, the other cleared only half, and
  // the half it skipped left the previous account's session in the browser for
  // whoever signed in next. See lib/sign-out.
  const signOut = () => signOutCompletely({ queryClient });

  // Nothing rather than the sign-in screen while the answer is still unknown.
  // The dashboard's own null-until-ready below already renders as a blank
  // frame, so this is the same silence one step earlier, not a new spinner.
  if (!onCircle && resolvingSession) return null;
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
  // There used to be a blocking gate here asking where this business should be
  // paid. The question is gone, not deferred: the account is now GIVEN an
  // address of its own, so there is nothing to ask and nothing to interrupt
  // anyone for. Asking was only ever a way of coping with a default nobody saw.
  return (
    <>
      <DashboardChrome signOut={signOut}>
        {/* Beside the dashboard, not in front of it. Creating the business's
            own settlement wallet needs a Circle challenge, and holding a
            merchant at a modal while that runs -- or worse, while it fails --
            costs them the session they came for. */}
        <SettlementWalletProvisioner
          account={myAccount}
          circleToken={currentSession()?.userToken ?? null}
        />
        {children}
      </DashboardChrome>
    </>
  );
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
          <SettleCurrencySelect value={settleCurrency} onChange={setSettleCurrency} />
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

// One identity provider, so no branch. This chose between PrivyDashboard and
// CircleDashboard on NEXT_PUBLIC_AUTH_PROVIDER until Phase 7.
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <CircleDashboard>{children}</CircleDashboard>;
}
