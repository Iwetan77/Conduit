"use client";

import { useHydrated } from "@/lib/use-hydrated";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount, useDisconnect, useChainId, useSwitchChain } from "wagmi";
import { useWalletGate, requestSignOut } from "@/lib/wallet-gate";
import { CIRCLE_CONNECTOR_ID } from "@/lib/circle/connector";
import { useEffect, useRef, useState } from "react";
import { CURRENCIES, type Currency } from "@conduit/sdk/lite";
import { Logo } from "./Logo";
import { TokenIcon } from "./TokenBadge";
import { WalletConnect } from "./WalletConnect";
import { arcTestnet } from "@/lib/wagmi";
import { useBalances } from "@/lib/use-balances";
import { usePayerUsdc, spendableUsdc } from "@/lib/use-payer-usdc";
import { chainLabel, usdcDisplay } from "@/lib/unified-balance";
import { shortenAddress } from "@/lib/format";

// Public payer-side nav. The merchant side is entered from the landing
// page ("Sign in as a merchant") — deliberately NOT a persistent nav item,
// so the payer surface reads as one product, not a door into another one.
const NAV_LINKS = [
  { href: "/send", label: "Send" },
  { href: "/create", label: "Create" },
  { href: "/links", label: "Links" },
  { href: "/history", label: "History" },
];

function formatBalance(raw: bigint | undefined, decimals: number): string {
  if (raw === undefined) return "—";
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const frac = (raw % divisor).toString().padStart(decimals, "0").slice(0, 2);
  return `${whole}.${frac}`;
}

const TOKEN_LIST = Object.keys(CURRENCIES) as Currency[];

function WalletMenu({ address }: { address: `0x${string}` }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { disconnect } = useDisconnect();
  const { connector } = useAccount();
  const isCircleSession = connector?.id === CIRCLE_CONNECTOR_ID;
  // Sign-out goes through the event, not a bare wagmi disconnect: that would
  // leave the Circle session in localStorage, so isAuthorized() still says yes
  // and the next page load signs the user straight back in. CircleStack does
  // both halves. `disconnect` is kept for a plain injected wallet, which has no
  // session of its own to clear.
  //
  // This used to branch on whether the Privy stack was mounted. It no longer
  // can: Circle is always live, so the event is always the right answer for a
  // Google session.
  const signOut = () => (isCircleSession ? requestSignOut() : disconnect());

  // Balances come from the Conduit API's cached endpoint (one server-side
  // Multicall3 read shared by every visitor), not from this browser. Split
  // per token on purpose: USDC and EURC are different assets, so a "unified"
  // total would need a live FX rate and imply a fungibility that doesn't
  // exist at pay time.
  const { balances, settled } = useBalances(address, open);
  // The cross-chain half of the same question, read only while the menu is
  // open so opening it costs the fan-out and merely having a nav does not.
  //
  // Without this the nav answered "your USDC" with the ARC balance alone while
  // the send form answered with the pooled source chains, so one screen showed
  // a payer three different USDC numbers and none of them was what they could
  // spend.
  const crossChain = usePayerUsdc({ address, family: "evm", enabled: open });
  const spendable = spendableUsdc(balances.USDC ?? 0n, crossChain);

  const held = TOKEN_LIST.map((currency) => ({ currency, raw: balances[currency] })).filter(
    // USDC (the hub currency) always shows so the menu never looks empty;
    // every other row needs a confirmed non-zero balance.
    (b) => b.currency === "USDC" || (b.raw !== undefined && b.raw > 0n)
  );

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-3 py-2
                   bg-surface border border-border
                   hover:border-ink-dim transition-colors"
      >
        <span className="w-2 h-2 bg-signal animate-pulse" />
        <span className="text-scale-2 font-mono text-ink">{shortenAddress(address)}</span>
        <svg
          className={`w-3 h-3 text-ink-dim transition-transform ${open ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-60 border border-border
                        bg-surface z-50 overflow-hidden">
          {/* Full address + copy — the one thing every wallet menu must have */}
          <button
            onClick={copyAddress}
            className="w-full px-3 py-2.5 border-b border-border flex items-center justify-between gap-2
                       text-left hover:bg-bg/50 transition-colors group"
            title="Copy address"
          >
            <span className="text-scale-1 font-mono text-ink-dim break-all leading-relaxed">
              {address}
            </span>
            <span className={`shrink-0 text-scale-1 font-mono ${copied ? "text-signal" : "text-ink-dim group-hover:text-ink"}`}>
              {copied ? "Copied" : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <rect x="9" y="9" width="11" height="11" rx="1" />
                  <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
                </svg>
              )}
            </span>
          </button>

          <div className="p-3 border-b border-border space-y-2.5">
            {held.map(({ currency, raw }) => {
              // USDC is the one token that is spendable across chains, so it is
              // the one token whose row is not simply the Arc balance. Every
              // other settle currency exists on Arc only.
              const isUsdc = currency === "USDC";
              const value = isUsdc
                ? usdcDisplay(spendable.minor)
                : settled || raw !== undefined
                  ? formatBalance(raw ?? 0n, CURRENCIES[currency].decimals)
                  : "—";
              return (
                <div key={currency}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <TokenIcon currency={currency} px={18} />
                      <span className="text-scale-1 text-ink-dim font-mono">{currency}</span>
                    </div>
                    <span className="text-scale-2 font-mono text-ink">{value}</span>
                  </div>
                  {/* The breakdown, on the surface the payer opened to look.
                      The headline number is what they can spend; this is where
                      it currently sits, per chain, because each chain that
                      contributes to a payment costs its own deposit. Only shown
                      when the balance actually spans more than one chain --
                      repeating a single chain's amount under itself is noise. */}
                  {isUsdc && spendable.via === "chains" && spendable.chains.length > 1 && (
                    <div className="mt-1.5 pl-[26px] space-y-1">
                      {spendable.chains.map((c) => (
                        <div key={c.chain} className="flex items-center justify-between">
                          <span className="text-scale-1 font-mono text-ink-dim">
                            {chainLabel(c.chain)}
                          </span>
                          <span className="text-scale-1 font-mono text-ink-dim">
                            {usdcDisplay(c.minor)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {isUsdc && spendable.via === "chains" && spendable.chains.length === 1 && (
                    <p className="text-scale-1 font-mono text-ink-dim mt-0.5 pl-[26px]">
                      on {chainLabel(spendable.chains[0].chain)}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <button
            onClick={() => { signOut(); setOpen(false); }}
            className="w-full px-4 py-3 text-left text-scale-2 font-mono text-danger/80
                       hover:text-danger hover:bg-danger/5 transition-colors"
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

// Shared connect UI. There used to be two provider stacks to handle here —
// plain wagmi connectors, or Privy's own connect modal once its stack was
// mounted, because @privy-io/wagmi stripped wagmi's connectors. With Privy
// gone there is one config containing every connector including Circle's, so
// this is a straight pass-through. Kept as a named component anyway: it is what
// stops the nav and the page bodies drifting apart again.
function ConnectButton() {
  return <WalletConnect />;
}

// `minimal` strips the app nav links (Send/Create/Links/History), leaving
// only the logo and the connect controls. The landing page uses it: those
// links are app navigation and belong on the app pages, not on a page whose
// job is to explain the product and hand you one CTA.
export function Nav({ minimal = false }: { minimal?: boolean } = {}) {
  const pathname = usePathname();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const mounted = useHydrated();
  const { walletSettled } = useWalletGate();

  const isWrongNetwork = mounted && walletSettled && isConnected && chainId !== arcTestnet.id;

  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b border-border bg-bg">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center">
        <div className="flex-1">
          <Logo size="sm" />
        </div>

        <nav className="hidden md:flex items-center gap-1">
          {(minimal ? [] : NAV_LINKS).map(({ href, label }) => {
            const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`px-3 py-1.5 text-scale-2 font-mono tracking-wider transition-colors ${
                  isActive
                    ? "text-ink bg-surface"
                    : "text-ink-dim hover:text-ink"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="flex-1 flex items-center justify-end">
          {/* walletSettled: until the Circle session is adopted, useAccount() reports
              whichever wallet an extension auto-connected, which is not
              necessarily the one this user signed in with. Showing it anyway
              flashed a MetaMask address — copyable, with a balance beside it —
              before swapping to the real one a second later. A placeholder of
              the same size holds the layout without asserting anything. */}
          {!mounted ? null : !walletSettled ? (
            <div className="h-9 w-32" aria-hidden />
          ) : isWrongNetwork ? (
            <button
              onClick={() => switchChain({ chainId: arcTestnet.id })}
              className="px-4 py-2 text-scale-2 font-mono bg-danger/10
                         text-danger border border-danger/30 hover:bg-danger/20 transition-colors"
            >
              Switch to Arc
            </button>
          ) : isConnected && address ? (
            <WalletMenu address={address} />
          ) : (
            <ConnectButton />
          )}
        </div>
      </div>
    </header>
  );
}

export function MobileNav({ minimal = false }: { minimal?: boolean } = {}) {
  const pathname = usePathname();

  if (minimal) return null;

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-bg md:hidden">
      <div className="flex">
        {NAV_LINKS.map(({ href, label }) => {
          const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`flex-1 py-3 text-center text-scale-1 font-mono tracking-wider transition-colors ${
                isActive ? "text-signal" : "text-ink-dim"
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
