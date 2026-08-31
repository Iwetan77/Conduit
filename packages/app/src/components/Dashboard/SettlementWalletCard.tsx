"use client";

// Where this business's money is, and where it lands.
//
// Both facts were reachable only by opening Settings, which is the wrong place
// for them: Settings is where you go to CHANGE something, and "how much do I
// have" is a thing a merchant checks constantly and changes never. So it lives
// on Settlements, beside the takings it explains — the page already answers
// "what came in", and this answers "what is actually there now", which is the
// same question one step later.
//
// It reports the BUSINESS's wallet, not the wallet the owner signed in with.
// Those are two different addresses (see the settlement-wallet work) and
// conflating them is how somebody reads their personal balance and believes it
// is the company's.
import { useMyAccount } from "@/lib/queries";
import { useBalances } from "@/lib/use-balances";
import { useCopy } from "@/lib/use-copy";
import { isoToToken, tokenLogoPath } from "@/lib/currencies";
import { TokenIcon } from "@/components/Shared/TokenBadge";
import { formatAmount, shortenAddress } from "@/lib/format";
import type { Currency } from "@conduit/sdk/lite";

const EXPLORER = process.env.NEXT_PUBLIC_EXPLORER ?? "https://testnet.arcscan.app";

export function SettlementWalletCard() {
  const { data: account } = useMyAccount();
  const address = account?.settle_address;
  const treasury = account?.settle_currency;
  const { balances, settled } = useBalances(address);
  const { copied, copy } = useCopy();

  // A reserved box rather than nothing, so the header does not reflow under the
  // cursor a moment after the page paints.
  if (!address) {
    return <div className="w-full sm:w-64 h-[92px]" aria-hidden />;
  }

  const treasuryToken = treasury ? isoToToken(treasury) : "USDC";
  const headline = (balances[treasuryToken as Currency] ?? 0n) as bigint;

  // Anything else the wallet holds, so a business paid in three currencies is
  // not told it has one. Zero balances are omitted: a list of noughts is a
  // worse answer than a short list.
  const others = (Object.entries(balances) as [Currency, bigint][])
    .filter(([token, amount]) => token !== treasuryToken && amount > 0n)
    .sort((a, b) => (b[1] > a[1] ? 1 : -1));

  return (
    <div className="w-full sm:w-64 border border-border bg-surface p-4 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-mono text-ink-dim uppercase tracking-widest">
          Settlement wallet
        </p>
        {/* Said out loud when income is NOT going to the wallet we provisioned.
            Somebody who pointed settlement at a treasury deserves to see that
            from the page reporting their takings, not to rediscover it. */}
        {account?.settle_address_source === "external" && (
          <span className="text-[10px] font-mono text-ink-dim">external</span>
        )}
      </div>

      <div className="flex items-baseline gap-2">
        {tokenLogoPath(treasuryToken) && (
          <TokenIcon currency={treasuryToken as Currency} px={18} />
        )}
        <p className="font-display text-xl font-bold text-ink leading-none">
          {/* Never "0" from a failed read. useBalances falls back to the last
              known snapshot and only calls a zero real once a read lands, and
              this waits for that rather than printing an empty wallet at
              somebody who has money in it. */}
          {settled ? formatAmount(headline, treasuryToken as Currency) : "—"}
        </p>
        <span className="font-mono text-xs text-ink-dim">{treasuryToken}</span>
      </div>

      {others.length > 0 && (
        <p className="font-mono text-[11px] text-ink-dim">
          plus{" "}
          {others.map(([token, amount], i) => (
            <span key={token}>
              {i > 0 && ", "}
              {formatAmount(amount, token)} {token}
            </span>
          ))}
        </p>
      )}

      {/* The address, copyable in one press.
          Shortened on screen and copied in full — a truncated address pasted
          into a wallet is money sent nowhere. */}
      <div className="flex items-center gap-2 pt-1 border-t border-border">
        <a
          href={`${EXPLORER}/address/${address}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-[11px] text-ink-dim hover:text-ink transition-colors"
          title={address}
        >
          {shortenAddress(address, 5)}
        </a>
        <button
          type="button"
          onClick={() => void copy(address, "settle")}
          className="font-mono text-[10px] uppercase tracking-wider text-ink-dim hover:text-signal transition-colors ml-auto"
        >
          {copied === "settle" ? "copied" : "copy"}
        </button>
      </div>
    </div>
  );
}
