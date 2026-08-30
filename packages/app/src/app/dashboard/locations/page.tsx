"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useSubAccounts, qk } from "@/lib/queries";
import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  listAccounts,
  createSubAccount,
  getStorefrontLink,
  createAccountApiKey,
  type Account,
  ConduitApiError,
} from "@/lib/conduit-api";
import { SettleCurrencySelect } from "@/components/Shared/SettleCurrencySelect";
import { tokenLabel } from "@/lib/format";
import { useCopy } from "@/lib/use-copy";
import { PageHeader } from "@/components/Dashboard/PageHeader";

function DownloadableQR({ value, filename }: { value: string; filename: string }) {
  const svgRef = useRef<SVGSVGElement>(null);

  const download = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const serializer = new XMLSerializer();
    const svgStr = serializer.serializeToString(svg);
    const canvas = document.createElement("canvas");
    // ~300dpi at a 1.5in print size = 450px; render well above that and let
    // the browser/printer downscale rather than upscale a blurry source.
    canvas.width = 900;
    canvas.height = 900;
    const ctx = canvas.getContext("2d")!;
    const img = new Image();
    img.onload = () => {
      // Canvas 2D context can't resolve CSS custom properties, so this stays a
      // literal — matches --bg (#050505), same exception as QRCodeSVG's own
      // bgColor/fgColor props above.
      ctx.fillStyle = "#050505";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      });
    };
    img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgStr)));
  };

  return (
    <div className="flex flex-col items-center gap-2">
      <div style={{ background: "var(--bg)", padding: 8, border: "1px solid var(--border)" }}>
        <QRCodeSVG ref={svgRef} value={value} size={120} bgColor="#050505" fgColor="#B2F55A" level="H" />
      </div>
      <button onClick={download} className="text-signal text-xs hover:underline">Download print-ready</button>
    </div>
  );
}

// One storefront, and the QR a customer actually scans at its till.
//
// The QR used to encode the storefront's raw settle_address. A phone camera
// can't act on a bare "0x..." string at all, and any wallet that did parse it
// would send a raw transfer — no amount, no conversion into the storefront's
// settle currency, no cross-chain, and no settlement row attributing the sale
// to this location, which is the entire reason storefronts exist. It now
// encodes the hosted URL of the storefront's standing open-amount link, so
// scanning opens Conduit's pay page: the customer types what they owe and can
// pay in any supported stablecoin from any supported chain.
function StorefrontCard({ account }: { account: Account }) {
  const [link, setLink] = useState<{ hosted_url: string } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    getStorefrontLink(account.id)
      .then((l) => live && setLink(l))
      .catch(() => live && setFailed(true));
    return () => { live = false; };
  }, [account.id]);

  const slug = account.name.replace(/\s+/g, "-");

  return (
    <div className="border border-border p-4 flex flex-col items-center gap-3">
      {/* Deliberately no settle address here. This card is the thing a cashier
          has open at the till, and an address on screen is something a customer
          can be handed or can photograph. Paying it directly moves real money
          on-chain while bypassing Conduit entirely -- no conversion into the
          storefront's currency, no settlement row, no attribution -- so it
          looks to everyone like a payment that succeeded and simply isn't
          there. The QR is the only thing on this card meant to leave it. */}
      <div className="text-center">
        <p className="font-medium text-sm">{account.name}</p>
        <p className="text-ink-dim text-xs">{tokenLabel(account.settle_currency)}</p>
      </div>
      {link ? (
        <>
          <DownloadableQR value={link.hosted_url} filename={`${slug}-qr.png`} />
          <p className="text-ink-dim text-[10px] font-mono break-all text-center">{link.hosted_url}</p>
        </>
      ) : failed ? (
        // Never render a QR we couldn't resolve: a wrong code printed and stuck
        // to a till is worse than a visibly missing one.
        <p className="text-danger text-xs text-center">Couldn&apos;t load this storefront&apos;s QR — reload to retry.</p>
      ) : (
        <p className="text-ink-dim text-xs">Loading QR…</p>
      )}
      <StorefrontKey accountId={account.id} />
    </div>
  );
}

// The storefront's own credential, for wiring a till to it.
//
// The static QR above serves a counter where the customer types the amount. A
// restaurant can't work that way: the total is only known when the bill is
// printed, so its point-of-sale has to mint a link per bill and print THAT as
// the QR on the receipt. Doing so needs a key belonging to this storefront —
// the parent's key would put the takings on the parent's books — which is why
// this lives on the storefront card rather than in Developers.
function StorefrontKey({ accountId }: { accountId: string }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { copied, copy } = useCopy();

  const mint = async () => {
    setError("");
    setBusy(true);
    try {
      const k = await createAccountApiKey(accountId);
      setSecret(k.key);
    } catch (err) {
      setError(err instanceof ConduitApiError ? err.message : "Couldn't create a key");
    } finally {
      setBusy(false);
    }
  };

  if (secret) {
    return (
      <div className="w-full border border-signal/30 bg-signal/10 p-3 space-y-2">
        <p className="text-signal text-[10px] font-mono uppercase tracking-wider">
          Copy this now — it is not shown again
        </p>
        <p className="text-ink text-[10px] font-mono break-all">{secret}</p>
        <button
          onClick={() => copy(secret, accountId)}
          className={`text-[10px] font-mono ${copied === accountId ? "text-signal" : "text-ink-dim hover:text-ink"}`}
        >
          {copied === accountId ? "Copied" : "Copy key"}
        </button>
      </div>
    );
  }

  return (
    <div className="w-full text-center">
      <button
        onClick={mint}
        disabled={busy}
        className="text-ink-dim text-[10px] font-mono hover:text-ink disabled:opacity-50"
      >
        {busy ? "Creating…" : "Create API key for a till"}
      </button>
      {error && <p className="text-danger text-[10px] mt-1">{error}</p>}
    </div>
  );
}

export default function LocationsPage() {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [settleCurrency, setSettleCurrency] = useState("EUR");
  const [settleAddress, setSettleAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [newKey, setNewKey] = useState<{ name: string; key: string } | null>(null);

  const qc = useQueryClient();
  const { data: accounts } = useSubAccounts();

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      // CreateSub returns the storefront's secret key exactly once. This used
      // to discard the whole response, which left every storefront holding a
      // live credential nobody could ever read — the reason a till couldn't be
      // wired to one. Surface it; it can also be re-minted from the card.
      const created = await createSubAccount({ name, settle_currency: settleCurrency, settle_address: settleAddress });
      if (created.api_key?.key) setNewKey({ name, key: created.api_key.key });
      setShowForm(false);
      setName("");
      setSettleAddress("");
      await qc.invalidateQueries({ queryKey: qk.subAccounts });
    } catch (err) {
      setError(err instanceof ConduitApiError ? err.message : "Failed to create storefront");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Storefronts"
        description="A reusable QR per location, so takings are attributed to the right one."
        action={
          <><button
          onClick={() => setShowForm((s) => !s)}
          className="border border-border px-4 py-2 text-sm"
        >
          {showForm ? "Cancel" : "Add storefront"}
        </button></>
        }
      />

      {showForm && (
        <form onSubmit={handleCreate} className="border border-border p-4 mb-6 space-y-3 max-w-md">
          <input
            className="w-full bg-surface border border-border px-3 py-2 text-sm focus:border-signal focus:outline-none"
            placeholder="Storefront name (e.g. Shibuya store)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <SettleCurrencySelect value={settleCurrency} onChange={setSettleCurrency} />
          <input
            className="w-full bg-surface border border-border px-3 py-2 text-sm font-mono focus:border-signal focus:outline-none"
            placeholder="0x... settle address"
            value={settleAddress}
            onChange={(e) => setSettleAddress(e.target.value)}
            required
          />
          {error && <p className="text-danger text-xs">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full bg-signal text-signal-ink font-medium py-2 text-sm disabled:opacity-50"
          >
            {busy ? "Creating..." : "Create storefront"}
          </button>
        </form>
      )}

      {newKey && (
        <div className="border border-signal/30 bg-signal/10 p-4 mb-6 space-y-2">
          <p className="text-signal text-xs font-mono uppercase tracking-wider">
            {newKey.name} — secret key. Copy it now, it is not shown again.
          </p>
          <p className="text-ink text-xs font-mono break-all">{newKey.key}</p>
          <p className="text-ink-dim text-xs">
            Use this from the storefront&apos;s till to create a payment link per bill. Lost keys
            can&apos;t be recovered, but you can mint a new one from the card below.
          </p>
          <button onClick={() => setNewKey(null)} className="text-ink-dim text-xs hover:text-ink">
            Dismiss
          </button>
        </div>
      )}

      {accounts === undefined && <p className="text-ink-dim text-sm">Loading...</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {accounts?.map((a) => (
          <StorefrontCard key={a.id} account={a} />
        ))}
      </div>

      {accounts?.length === 1 && !showForm && (
        <p className="text-ink-dim text-sm mt-4">
          No storefronts yet beyond your main account — click &quot;Add storefront&quot; to create one.
        </p>
      )}
    </div>
  );
}
