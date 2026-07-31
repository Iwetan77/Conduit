"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { ethers } from "ethers";
import { WalletConnect } from "@/components/Shared/WalletConnect";
import { CURRENCIES } from "@conduit/sdk";
import { getMyAccount, updateAccount, type Account, ConduitApiError } from "@/lib/conduit-api";
import { SETTLE_CURRENCIES, currencyFlag } from "@/lib/currencies";

// Phase 4: recipient identity. What a payer sees instead of a bare hex
// address on every payment link/QR/`/pay` page -- edited here.
function BusinessIdentity() {
  const [account, setAccount] = useState<Account | null>(null);
  const [name, setName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [settleCurrency, setSettleCurrency] = useState("EUR");
  const [settleAddress, setSettleAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    getMyAccount()
      .then((a) => {
        setAccount(a);
        setName(a.name);
        setLogoUrl(a.logo_url ?? "");
        setSettleCurrency(a.settle_currency);
        setSettleAddress(a.settle_address);
      })
      .catch((err) => setError(err instanceof ConduitApiError ? err.message : "Failed to load account"));
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account) return;
    setError("");
    setStatus("");
    setBusy(true);
    try {
      const updated = await updateAccount(account.id, {
        name,
        logo_url: logoUrl || undefined,
        settle_currency: settleCurrency,
        settle_address: settleAddress,
      });
      setAccount(updated);
      setStatus("Saved.");
    } catch (err) {
      setError(err instanceof ConduitApiError ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-border p-6 space-y-4">
      <div>
        <h2 className="font-medium text-sm mb-1">Business identity</h2>
        <p className="text-xs text-ink-dim">
          Shown to payers on every payment link, QR, and the pay page instead of your bare settle address.
        </p>
      </div>

      {!account && !error && <p className="text-ink-dim text-xs">Loading...</p>}

      {account && (
        <form onSubmit={handleSave} className="space-y-3">
          <div>
            <label className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider block mb-1">Display name</label>
            <input
              className="w-full bg-surface border border-border px-3 py-2 text-sm focus:border-signal focus:outline-none"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider block mb-1">Logo URL (optional)</label>
            <input
              className="w-full bg-surface border border-border px-3 py-2 text-sm focus:border-signal focus:outline-none"
              placeholder="https://..."
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider block mb-1">Settle currency</label>
              <select
                className="w-full bg-surface border border-border px-3 py-2 text-sm focus:border-signal focus:outline-none"
                value={settleCurrency}
                onChange={(e) => setSettleCurrency(e.target.value)}
              >
                {SETTLE_CURRENCIES.map((c) => (
                  <option key={c} value={c}>{currencyFlag(c)} {c}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider block mb-1">Settle address</label>
            <input
              className="w-full bg-surface border border-border px-3 py-2 text-sm font-mono focus:border-signal focus:outline-none"
              value={settleAddress}
              onChange={(e) => setSettleAddress(e.target.value)}
              required
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="w-full bg-signal text-signal-ink font-medium py-2 text-sm disabled:opacity-50"
          >
            {busy ? "Saving..." : "Save"}
          </button>
        </form>
      )}

      {status && <p className="text-signal text-xs">{status}</p>}
      {error && <p className="text-danger text-xs">{error}</p>}
    </div>
  );
}

const SETTLEMENT_PREFERENCE_REGISTRY = process.env["NEXT_PUBLIC_SETTLEMENT_PREFERENCE_REGISTRY"] as `0x${string}` | undefined;

const PREF_REGISTRY_ABI = [
  "function setPreference(address token) external",
  "function clearPreference() external",
  "function preferenceOf(address) view returns (address token, bool active)",
] as const;

export default function SettingsPage() {
  const { address, isConnected } = useAccount();
  const [tokenSymbol, setTokenSymbol] = useState<keyof typeof CURRENCIES>("EURC");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const handleSetPreference = async () => {
    if (!SETTLEMENT_PREFERENCE_REGISTRY) {
      setError("SettlementPreferenceRegistry address not configured (NEXT_PUBLIC_SETTLEMENT_PREFERENCE_REGISTRY)");
      return;
    }
    setError("");
    setStatus("");
    setBusy(true);
    try {
      const provider = new ethers.BrowserProvider((window as unknown as { ethereum: unknown }).ethereum as ethers.Eip1193Provider);
      const signer = await provider.getSigner();
      const contract = new ethers.Contract(SETTLEMENT_PREFERENCE_REGISTRY, PREF_REGISTRY_ABI, signer);
      const tokenAddress = CURRENCIES[tokenSymbol].token;
      const tx = await contract["setPreference"](tokenAddress);
      setStatus(`Submitted: ${tx.hash} — waiting for confirmation...`);
      await tx.wait();
      setStatus(`Confirmed on-chain. Standing preference set to ${tokenSymbol}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transaction failed");
    } finally {
      setBusy(false);
    }
  };

  const handleClearPreference = async () => {
    if (!SETTLEMENT_PREFERENCE_REGISTRY) return;
    setError("");
    setStatus("");
    setBusy(true);
    try {
      const provider = new ethers.BrowserProvider((window as unknown as { ethereum: unknown }).ethereum as ethers.Eip1193Provider);
      const signer = await provider.getSigner();
      const contract = new ethers.Contract(SETTLEMENT_PREFERENCE_REGISTRY, PREF_REGISTRY_ABI, signer);
      const tx = await contract["clearPreference"]();
      setStatus(`Submitted: ${tx.hash} — waiting for confirmation...`);
      await tx.wait();
      setStatus("Standing preference cleared.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transaction failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-md space-y-8">
      <h1 className="font-display text-3xl font-bold">Settings</h1>

      <BusinessIdentity />

      <div className="border border-border p-6 space-y-4">
        <div>
          <h2 className="font-medium text-sm mb-1">Standing settlement preference</h2>
          <p className="text-xs text-ink-dim">
            An on-chain preference (writes <code>SettlementPreferenceRegistry.sol</code>) — every direct payment
            (no invoice/declaration) sent to your address is forced to settle in this token, or the payment is
            rejected outright rather than silently honoring whatever the sender chose.
          </p>
        </div>

        {!isConnected ? (
          <WalletConnect />
        ) : (
          <>
            <p className="text-xs text-ink-dim font-mono">{address}</p>
            <select
              className="w-full bg-surface border border-border px-3 py-2 text-sm focus:border-signal focus:outline-none"
              value={tokenSymbol}
              onChange={(e) => setTokenSymbol(e.target.value as keyof typeof CURRENCIES)}
            >
              {Object.keys(CURRENCIES).map((sym) => (
                <option key={sym} value={sym}>{sym}</option>
              ))}
            </select>
            <div className="flex gap-2">
              <button
                onClick={handleSetPreference}
                disabled={busy}
                className="flex-1 bg-signal text-signal-ink font-medium py-2 text-sm disabled:opacity-50"
              >
                {busy ? "Submitting..." : "Set preference"}
              </button>
              <button
                onClick={handleClearPreference}
                disabled={busy}
                className="border border-border py-2 px-4 text-sm disabled:opacity-50"
              >
                Clear
              </button>
            </div>
          </>
        )}

        {status && <p className="text-signal text-xs">{status}</p>}
        {error && <p className="text-danger text-xs">{error}</p>}
      </div>
    </div>
  );
}
