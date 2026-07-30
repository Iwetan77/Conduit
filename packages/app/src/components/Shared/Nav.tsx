"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useAccount, useBalance, useConnect, useDisconnect, useChainId, useSwitchChain } from "wagmi";
import { useEffect, useRef, useState } from "react";
import { ARC_TESTNET } from "@conduit/sdk";
import { Logo } from "./Logo";
import { arcTestnet } from "@/lib/wagmi";
import { shortenAddress } from "@/lib/format";

const NAV_LINKS = [
  { href: "/", label: "Send" },
  { href: "/create", label: "Create" },
  { href: "/links", label: "Links" },
  { href: "/history", label: "History" },
];

function formatBalance(raw: bigint | undefined, decimals: number): string {
  if (raw === undefined) return "—";
  const divisor = BigInt(10 ** decimals);
  const whole = raw / divisor;
  const frac = (raw % divisor).toString().padStart(decimals, "0").slice(0, 2);
  return `${whole}.${frac}`;
}

function WalletMenu({ address }: { address: `0x${string}` }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { disconnect } = useDisconnect();

  const { data: usdcData } = useBalance({
    address,
    token: ARC_TESTNET.tokens.USDC as `0x${string}`,
    query: { refetchInterval: 5000 },
  });
  const { data: eurcData } = useBalance({
    address,
    token: ARC_TESTNET.tokens.EURC as `0x${string}`,
    query: { refetchInterval: 5000 },
  });

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
        <div className="absolute right-0 top-full mt-2 w-56 border border-border
                        bg-bg z-50 overflow-hidden">
          <div className="p-3 border-b border-border space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Image src="/usdc.svg" alt="USDC" width={18} height={18} />
                <span className="text-scale-1 text-ink-dim font-mono">USDC</span>
              </div>
              <span className="text-scale-2 font-mono text-ink">
                {formatBalance(usdcData?.value, usdcData?.decimals ?? 6)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Image src="/eurc.svg" alt="EURC" width={18} height={18} />
                <span className="text-scale-1 text-ink-dim font-mono">EURC</span>
              </div>
              <span className="text-scale-2 font-mono text-ink">
                {formatBalance(eurcData?.value, eurcData?.decimals ?? 6)}
              </span>
            </div>
          </div>
          <button
            onClick={() => { disconnect(); setOpen(false); }}
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

function ConnectButton() {
  const { connect, connectors, isPending } = useConnect();
  const injected = connectors.find((c) => c.id === "injected");
  const wc = connectors.find((c) => c.id === "walletConnect");

  return (
    <div className="flex items-center gap-2">
      {injected && (
        <button
          onClick={() => connect({ connector: injected })}
          disabled={isPending}
          className="px-4 py-2 text-scale-2 font-mono bg-signal text-signal-ink
                     hover:bg-signal/90 transition-colors disabled:opacity-50"
        >
          {isPending ? "Connecting..." : "Connect Wallet"}
        </button>
      )}
      {wc && (
        <button
          onClick={() => connect({ connector: wc })}
          disabled={isPending}
          className="px-3 py-2 text-scale-2 font-mono border border-border
                     text-ink-dim hover:text-ink hover:border-ink-dim
                     transition-colors disabled:opacity-50"
        >
          WC
        </button>
      )}
    </div>
  );
}

export function Nav() {
  const pathname = usePathname();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const isWrongNetwork = mounted && isConnected && chainId !== arcTestnet.id;

  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b border-border bg-bg/90">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center">
        <div className="flex-1">
          <Logo size="sm" />
        </div>

        <nav className="hidden md:flex items-center gap-1">
          {NAV_LINKS.map(({ href, label }) => {
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
          {!mounted ? null : isWrongNetwork ? (
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

export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-bg/95 md:hidden">
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
