"use client";

// Phase 2 spike for the Privy → Circle Wallets migration. Not linked from
// anywhere and not part of the product.
//
// Phase 1 proved a Circle wallet can SIGN. This one asks the harder question:
//
//   Can a Circle wallet send a real on-chain transaction through an ordinary
//   EIP-1193 + ethers.BrowserProvider call path, and hand back a tx hash?
//
// It matters because Circle has no eth_sendTransaction. It prepares a
// challenge, the user approves it in Circle's UI, Circle broadcasts, and you
// get an id of Circle's own — while every caller in this codebase expects a
// hash it can pass to waitForTransaction(). lib/circle/provider.ts closes that
// gap; this page is the proof it holds against the live chain.
//
// Deliberately written the way the app writes transactions — BrowserProvider,
// ethers.Contract, .transfer(...) — and NOT by calling the provider directly.
// A bespoke call path here would prove nothing about the eight real call sites.

import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { useCircleSession } from "@/lib/circle/session";
import { createCircleProvider } from "@/lib/circle/provider";
import { ARC_RPC_URL, arcTestnet } from "@/lib/chain";

const API_BASE = process.env.NEXT_PUBLIC_CONDUIT_API_URL ?? "http://localhost:8080";
const APP_ID = process.env.NEXT_PUBLIC_CIRCLE_APP_ID ?? "";
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
const SPIKE_PATH = "/dev/circle-tx";

// USDC on Arc Testnet, from the currency registry the API serves.
const USDC = "0x3600000000000000000000000000000000000000";
const USDC_DECIMALS = 6;
const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

export default function CircleTxPage() {
  const session = useCircleSession({
    apiBase: API_BASE,
    appId: APP_ID,
    googleClientId: GOOGLE_CLIENT_ID,
    redirectPath: SPIKE_PATH,
  });

  const [to, setTo] = useState("0xf04a181eaB4CfABf7D13CCe64737782737cD0b22");
  const [amount, setAmount] = useState("0.01");
  const [usdc, setUsdc] = useState<string>();
  const [gas, setGas] = useState<string>();
  const [stage, setStage] = useState<string>();
  const [hash, setHash] = useState<string>();
  const [receipt, setReceipt] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  // Balances, read straight from Arc — nothing to do with Circle.
  //
  // Shown because a brand-new Circle wallet is empty, and an unfunded send
  // fails inside estimateGas with a bare "execution reverted" that says
  // nothing about the cause. Arc charges gas in USDC, so one balance covers
  // both the transfer and the fee.
  useEffect(() => {
    if (!session.wallet?.address) return;
    (async () => {
      try {
        const provider = new ethers.JsonRpcProvider(ARC_RPC_URL, arcTestnet.id);
        const token = new ethers.Contract(USDC, ERC20_ABI, provider);
        const [bal, native] = await Promise.all([
          token.balanceOf(session.wallet!.address) as Promise<bigint>,
          provider.getBalance(session.wallet!.address),
        ]);
        setUsdc(ethers.formatUnits(bal, USDC_DECIMALS));
        setGas(ethers.formatEther(native));
      } catch (e) {
        setError(`could not read balances: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }, [session.wallet?.address]);

  const send = async () => {
    if (!session.wallet || !session.userToken) return;
    setBusy(true);
    setError(undefined);
    setHash(undefined);
    setReceipt(undefined);
    try {
      // The whole point: an ordinary EIP-1193 provider, wrapped by ethers,
      // exactly as every write path in the app already does it.
      const eip1193 = createCircleProvider({
        address: session.wallet.address,
        walletId: session.wallet.id,
        userToken: session.userToken,
        apiBase: API_BASE,
        execute: session.execute,
        onProgress: setStage,
      });
      const browserProvider = new ethers.BrowserProvider(eip1193, arcTestnet.id);
      const signer = await browserProvider.getSigner();
      const token = new ethers.Contract(USDC, ERC20_ABI, signer);

      // Minor units, integer. Never a float — this is money.
      const value = ethers.parseUnits(amount, USDC_DECIMALS);

      setStage("submitting…");
      const tx = await token.transfer(to, value);
      setHash(tx.hash);
      setStage("waiting for the receipt…");

      // Confirms the hash is real: a hash the chain does not know is worse
      // than no hash, because callers would wait on it forever.
      const rec = await browserProvider.waitForTransaction(tx.hash, 1, 120_000);
      setReceipt(
        rec
          ? `block ${rec.blockNumber}, status ${rec.status === 1 ? "success" : "REVERTED"}, gas used ${rec.gasUsed}`
          : "no receipt within 120s"
      );
      setStage(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage(undefined);
    } finally {
      setBusy(false);
    }
  };

  const funded = usdc !== undefined && Number(usdc) > 0;

  return (
    <main className="min-h-screen p-8 max-w-2xl mx-auto">
      <h1 className="font-display text-2xl font-bold text-ink">
        Circle Wallets — Phase 2 spike
      </h1>
      <p className="text-ink-dim text-sm mt-2">
        Sends real USDC on Arc from a Google-provisioned Circle wallet, through
        ethers.BrowserProvider over an EIP-1193 adapter — the same call path the
        app already uses. Not part of the product.
      </p>

      {session.status !== "ready" ? (
        <div className="mt-6">
          <button
            onClick={session.signIn}
            disabled={session.status === "connecting"}
            className="bg-signal text-signal-ink font-mono px-5 py-2.5 text-sm disabled:opacity-50"
          >
            {session.status === "connecting" ? "Connecting…" : "Sign in with Google"}
          </button>
        </div>
      ) : (
        <div className="mt-6 border border-border bg-surface p-4 space-y-1">
          <p className="text-xs font-mono text-ink break-all">{session.wallet?.address}</p>
          <p className="text-xs font-mono text-ink-dim">
            {usdc ?? "…"} USDC · {gas ?? "…"} native gas
          </p>
          {usdc !== undefined && !funded && (
            <p className="text-xs font-mono text-danger pt-2">
              This wallet is empty. Send it some testnet USDC on Arc first — Arc
              charges gas in USDC, so it needs a balance to send at all.
            </p>
          )}
        </div>
      )}

      {session.status === "ready" && (
        <div className="mt-6 space-y-3">
          <label className="block">
            <span className="text-[10px] font-mono text-ink-dim uppercase tracking-wider">To</span>
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-full mt-1 bg-surface border border-border p-2 text-xs font-mono text-ink"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-mono text-ink-dim uppercase tracking-wider">
              Amount (USDC)
            </span>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full mt-1 bg-surface border border-border p-2 text-xs font-mono text-ink"
            />
          </label>
          <button
            onClick={send}
            disabled={busy || !funded}
            className="bg-signal text-signal-ink font-mono px-5 py-2.5 text-sm disabled:opacity-50"
          >
            {busy ? "Sending…" : "Send USDC"}
          </button>
        </div>
      )}

      {stage && <p className="mt-4 text-xs font-mono text-ink-dim">{stage}</p>}

      {hash && (
        <div className="mt-6 border border-signal/40 bg-signal/10 p-4">
          <p className="text-[10px] font-mono text-ink-dim uppercase tracking-wider mb-1">
            Transaction hash returned to the caller
          </p>
          <a
            href={`${arcTestnet.blockExplorers.default.url}/tx/${hash}`}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-mono text-ink underline break-all"
          >
            {hash}
          </a>
          {receipt && <p className="text-xs font-mono text-ink-dim mt-2">{receipt}</p>}
        </div>
      )}

      {(error || session.error) && (
        <p className="mt-6 p-4 border border-danger/40 bg-danger/10 text-danger text-sm break-all">
          {error ?? session.error}
        </p>
      )}

      {session.log.length > 0 && (
        <div className="mt-6 border border-border bg-surface p-4">
          <p className="text-[10px] font-mono text-ink-dim uppercase tracking-wider mb-2">
            Session
          </p>
          {session.log.map((l) => (
            <p key={l} className="text-ink-dim text-xs font-mono">
              {l}
            </p>
          ))}
        </div>
      )}
    </main>
  );
}
