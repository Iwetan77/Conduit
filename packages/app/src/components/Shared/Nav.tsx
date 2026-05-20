"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useAccount, useBalance } from "wagmi";
import { useEffect, useState } from "react";
import { ARC_TESTNET } from "@conduit/sdk";
import { Logo } from "./Logo";
import { WalletConnect } from "./WalletConnect";

const NAV_LINKS = [
  { href: "/", label: "Send" },
  { href: "/create", label: "Create" },
  { href: "/links", label: "Links" },
  { href: "/history", label: "History" },
];

function formatBalance(raw: bigint | undefined, decimals: number): string {
  if (raw === undefined) return "0.00";
  const divisor = BigInt(10 ** decimals);
  const whole = raw / divisor;
  const frac = (raw % divisor).toString().padStart(decimals, "0").slice(0, 2);
  const str = `${whole}.${frac}`;
  return str.length > 8 ? str.slice(0, 8) : str;
}

function WalletBalances({ address }: { address: `0x${string}` }) {
  const { data: usdcData, isLoading: usdcLoading } = useBalance({
    address,
    token: ARC_TESTNET.tokens.USDC as `0x${string}`,
    query: { refetchInterval: 5000 },
  });
  const { data: eurcData, isLoading: eurcLoading } = useBalance({
    address,
    token: ARC_TESTNET.tokens.EURC as `0x${string}`,
    query: { refetchInterval: 5000 },
  });

  return (
    <div className="hidden md:flex items-center gap-4">
      <div className="flex items-center gap-1.5">
        <Image src="/usdc.svg" alt="USDC" width={22} height={22} />
        {usdcLoading ? (
          <span className="w-14 h-3 bg-brand-surface animate-pulse rounded block" />
        ) : (
          <span className="font-mono text-xs text-brand-white">
            {formatBalance(usdcData?.value, usdcData?.decimals ?? 6)}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <Image src="/eurc.svg" alt="EURC" width={22} height={22} />
        {eurcLoading ? (
          <span className="w-14 h-3 bg-brand-surface animate-pulse rounded block" />
        ) : (
          <span className="font-mono text-xs text-brand-white">
            {formatBalance(eurcData?.value, eurcData?.decimals ?? 6)}
          </span>
        )}
      </div>
    </div>
  );
}

export function Nav() {
  const pathname = usePathname();
  const { address, isConnected } = useAccount();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b border-brand-border bg-brand-black/90 backdrop-blur-sm">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <Logo size="sm" />

        <nav className="hidden md:flex items-center gap-1">
          {NAV_LINKS.map(({ href, label }) => {
            const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`px-3 py-1.5 rounded-lg text-sm font-mono tracking-wider transition-colors ${
                  isActive
                    ? "text-brand-white bg-brand-surface"
                    : "text-brand-muted hover:text-brand-white"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-4">
          {mounted && isConnected && address && (
            <WalletBalances address={address} />
          )}
          <WalletConnect />
        </div>
      </div>
    </header>
  );
}

export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-brand-border bg-brand-black/95 backdrop-blur-sm md:hidden">
      <div className="flex">
        {NAV_LINKS.map(({ href, label }) => {
          const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`flex-1 py-3 text-center text-xs font-mono tracking-wider transition-colors ${
                isActive ? "text-brand-green" : "text-brand-muted"
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
