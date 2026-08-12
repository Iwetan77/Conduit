"use client";

import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { listAccounts, createSubAccount, getStorefrontLink, type Account, ConduitApiError } from "@/lib/conduit-api";
import { SETTLE_CURRENCIES as CURRENCIES, currencyFlag } from "@/lib/currencies";
import { tokenLabel } from "@/lib/format";
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
    </div>
  );
}

export default function LocationsPage() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [settleCurrency, setSettleCurrency] = useState("EUR");
  const [settleAddress, setSettleAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = () => { listAccounts().then((r) => setAccounts(r.data ?? [])).catch(() => {}); };
  useEffect(refresh, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await createSubAccount({ name, settle_currency: settleCurrency, settle_address: settleAddress });
      setShowForm(false);
      setName("");
      setSettleAddress("");
      refresh();
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
          <select
            className="w-full bg-surface border border-border px-3 py-2 text-sm focus:border-signal focus:outline-none"
            value={settleCurrency}
            onChange={(e) => setSettleCurrency(e.target.value)}
          >
            {CURRENCIES.map((c) => <option key={c} value={c}>{currencyFlag(c)} {c}</option>)}
          </select>
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

      {accounts === null && <p className="text-ink-dim text-sm">Loading...</p>}

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
