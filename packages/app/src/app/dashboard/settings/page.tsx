"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { ethers } from "ethers";
import { WalletConnect } from "@/components/Shared/WalletConnect";
import { CURRENCIES } from "@conduit/sdk";

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

      <div className="border border-brand-border rounded-lg p-6 space-y-4">
        <div>
          <h2 className="font-medium text-sm mb-1">Standing settlement preference</h2>
          <p className="text-xs text-brand-muted">
            An on-chain preference (writes <code>SettlementPreferenceRegistry.sol</code>) — every direct payment
            (no invoice/declaration) sent to your address is forced to settle in this token, or the payment is
            rejected outright rather than silently honoring whatever the sender chose.
          </p>
        </div>

        {!isConnected ? (
          <WalletConnect />
        ) : (
          <>
            <p className="text-xs text-brand-muted font-mono">{address}</p>
            <select
              className="w-full bg-brand-surface border border-brand-border rounded px-3 py-2 text-sm"
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
                className="flex-1 bg-brand-green text-brand-black font-medium rounded py-2 text-sm disabled:opacity-50"
              >
                {busy ? "Submitting..." : "Set preference"}
              </button>
              <button
                onClick={handleClearPreference}
                disabled={busy}
                className="border border-brand-border rounded py-2 px-4 text-sm disabled:opacity-50"
              >
                Clear
              </button>
            </div>
          </>
        )}

        {status && <p className="text-brand-green text-xs">{status}</p>}
        {error && <p className="text-red-400 text-xs">{error}</p>}
      </div>
    </div>
  );
}
