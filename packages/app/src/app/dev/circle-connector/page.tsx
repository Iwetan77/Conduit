"use client";

// Phase 3 gate for the Privy → Circle Wallets migration. Not linked from
// anywhere and not part of the product.
//
// Phase 1 proved a Circle wallet can sign. Phase 2 proved it can send. This
// page asks the question the migration's cost actually depends on:
//
//   Can the app reach a Circle wallet through the code it ALREADY has?
//
// So it deliberately contains no Circle-specific code below the connect
// button. It uses wagmi's useAccount()/useConnect(), then hands the connector
// to getWalletProvider() — the same untouched function every write path in the
// app calls — and signs and sends through what comes back.
//
// The gate is not "it worked". It is that lib/wallet-provider.ts needed NO
// changes. If it had, the adapter is in the wrong place and the migration
// would mean editing every call site instead of one file.

import { useState } from "react";
import { ethers } from "ethers";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { CIRCLE_CONNECTOR_ID } from "@/lib/circle/connector";
import { arcTestnet } from "@/lib/chain";

const USDC = "0x3600000000000000000000000000000000000000";
const USDC_DECIMALS = 6;
const ERC20_ABI = ["function transfer(address to, uint256 amount) returns (bool)"];

type Status = "pending" | "running" | "pass" | "fail";
interface Check {
  name: string;
  status: Status;
  detail?: string;
}

const CHECKS = [
  "useAccount() reports the Circle wallet",
  "getWalletProvider(connector) returns a provider",
  "BrowserProvider signer address matches",
  "personal_sign recovers to the wallet",
  "ERC-20 transfer returns a tx hash",
] as const;

export default function CircleConnectorPage() {
  const { address, isConnected, connector } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  const [checks, setChecks] = useState<Check[]>(
    CHECKS.map((name) => ({ name, status: "pending" as Status }))
  );
  const [verdict, setVerdict] = useState<string>();
  const [busy, setBusy] = useState(false);

  const circle = connectors.find((c) => c.id === CIRCLE_CONNECTOR_ID);
  const onCircle = isConnected && connector?.id === CIRCLE_CONNECTOR_ID;
  const set = (i: number, status: Status, detail?: string) =>
    setChecks((prev) => prev.map((c, idx) => (idx === i ? { ...c, status, detail } : c)));

  const run = async () => {
    setBusy(true);
    setVerdict(undefined);
    setChecks(CHECKS.map((name) => ({ name, status: "pending" as Status })));
    try {
      // 1 — wagmi knows the wallet, with no Circle-specific code here.
      //
      // The connector identity is asserted, not just reported. Without this
      // the gate ran against whatever wallet happened to be connected — an
      // injected extension auto-reconnecting is enough — and passed four
      // checks about a wallet the migration has nothing to do with. A gate
      // that can pass without exercising the thing under test is worse than
      // no gate.
      set(0, "running");
      if (!isConnected || !address) throw new Error("not connected");
      if (connector?.id !== CIRCLE_CONNECTOR_ID) {
        throw new Error(
          `connected via "${connector?.id}", not the Circle connector. Disconnect and sign in with Google.`
        );
      }
      set(0, "pass", `${address} via connector "${connector.id}"`);

      // 2 — THE gate. Unmodified, exactly as every write path calls it.
      set(1, "running");
      const { getWalletProvider } = await import("@/lib/wallet-provider");
      const eip1193 = await getWalletProvider(connector);
      set(1, "pass", "resolved from the wagmi connector");

      // 3 — ethers must agree about who is signing.
      set(2, "running");
      const browserProvider = new ethers.BrowserProvider(eip1193, arcTestnet.id);
      const signer = await browserProvider.getSigner();
      const signerAddress = await signer.getAddress();
      if (signerAddress.toLowerCase() !== address.toLowerCase()) {
        throw new Error(`signer is ${signerAddress}, wallet is ${address}`);
      }
      set(2, "pass", signerAddress);

      // 4 — recover locally rather than trusting what the wallet reports.
      // A provider that signs with a key other than the address it advertises
      // is the exact failure that made Privy's embedded wallet unusable.
      set(3, "running", "approve in the Circle dialog…");
      const message = `Conduit Phase 3 gate ${new Date().toISOString()}`;
      const signature = await signer.signMessage(message);
      const recovered = ethers.verifyMessage(message, signature);
      if (recovered.toLowerCase() !== address.toLowerCase()) {
        throw new Error(`recovered ${recovered}, expected ${address}`);
      }
      set(3, "pass", `recovered ${recovered}`);

      // 5 — a real transaction, through the same provider.
      set(4, "running", "approve in the Circle dialog…");
      const token = new ethers.Contract(USDC, ERC20_ABI, signer);
      const tx = await token.transfer(address, ethers.parseUnits("0.01", USDC_DECIMALS));
      set(4, "pass", tx.hash);

      setVerdict(
        "PASS — the app reached a Circle wallet through getWalletProvider() with " +
          "no changes to that file. Every existing write path works as-is."
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setChecks((prev) => {
        const i = prev.findIndex((c) => c.status === "running");
        return i === -1
          ? prev
          : prev.map((c, idx) => (idx === i ? { ...c, status: "fail", detail: msg } : c));
      });
      setVerdict(`Stopped: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen p-8 max-w-2xl mx-auto">
      <h1 className="font-display text-2xl font-bold text-ink">
        Circle Wallets — Phase 3 gate
      </h1>
      <p className="text-ink-dim text-sm mt-2">
        A Circle wallet reached through wagmi and the app&apos;s own
        getWalletProvider(), with no Circle-specific code in the call path. Not
        part of the product.
      </p>

      <div className="mt-6 flex items-center gap-3">
        {/* Shown whenever the CIRCLE connector is not the connected one — an
            injected extension auto-reconnecting would otherwise hide the only
            control that gets this page to the wallet it exists to test. */}
        {!onCircle && (
          <button
            onClick={() => circle && connect({ connector: circle })}
            disabled={!circle || isPending}
            className="bg-signal text-signal-ink font-mono px-5 py-2.5 text-sm disabled:opacity-50"
          >
            {isPending ? "Connecting…" : "Sign in with Google"}
          </button>
        )}
        {onCircle && (
          <button
            onClick={run}
            disabled={busy}
            className="bg-signal text-signal-ink font-mono px-5 py-2.5 text-sm disabled:opacity-50"
          >
            {busy ? "Running…" : "Run gate"}
          </button>
        )}
        {isConnected && (
          <button
            onClick={() => disconnect()}
            className="border border-border text-ink-dim font-mono px-4 py-2.5 text-xs"
          >
            Disconnect {connector?.id}
          </button>
        )}
      </div>

      {/* What wagmi actually has. "Not registered" on its own gives nothing to
          act on: the connector could be missing because the env vars never
          reached the bundle, or because this page is under a different wagmi
          config than the one it was added to. The list tells those apart. */}
      <p className="mt-3 text-[10px] font-mono text-ink-dim break-all">
        connectors: {connectors.map((c) => c.id).join(", ") || "(none)"}
        {!circle && (
          <span className="text-danger">
            {" "}
            — no &quot;{CIRCLE_CONNECTOR_ID}&quot; connector in this config
          </span>
        )}
      </p>

      {isConnected && (
        <p className="mt-4 text-xs font-mono text-ink-dim break-all">
          connected: {address} (connector {connector?.id})
        </p>
      )}

      <ol className="mt-8 space-y-2">
        {checks.map((c, i) => (
          <li key={c.name} className="border border-border bg-surface p-3">
            <div className="flex items-center gap-3">
              <span
                className={`w-2 h-2 shrink-0 ${
                  c.status === "pass"
                    ? "bg-signal"
                    : c.status === "fail"
                      ? "bg-danger"
                      : c.status === "running"
                        ? "bg-signal animate-pulse"
                        : "bg-border"
                }`}
              />
              <span className="text-ink text-sm font-mono">
                {i + 1}. {c.name}
              </span>
            </div>
            {c.detail && (
              <p className="text-ink-dim text-xs font-mono mt-1.5 pl-5 break-all">{c.detail}</p>
            )}
          </li>
        ))}
      </ol>

      {verdict && (
        <p
          className={`mt-6 p-4 border text-sm ${
            verdict.startsWith("PASS")
              ? "border-signal/40 bg-signal/10 text-ink"
              : "border-danger/40 bg-danger/10 text-danger"
          }`}
        >
          {verdict}
        </p>
      )}
    </main>
  );
}
