"use client";

import type { Eip1193Provider } from "ethers";
import type { Connector } from "wagmi";

// The EIP-1193 provider for the wallet the user ACTUALLY connected.
//
// Every write path used to reach for `window.ethereum` directly, which is
// wrong in two common cases:
//
//   1. Google sign-in provisions a Circle user-controlled wallet (a Privy
//      embedded wallet, before Phase 7). It is not an
//      extension and never injects `window.ethereum`, so the send failed
//      with an opaque fetch/"Load failed" error before any transaction
//      existed.
//   2. With more than one wallet extension installed, `window.ethereum` is
//      whichever one won the injection race — not necessarily the one wagmi
//      is connected to. Signing then comes from a different address than the
//      one on screen, so the router's transferFrom pulls from an account with
//      no allowance and the payment reverts.
//
// wagmi's connector is the single source of truth for "the connected wallet",
// so ask it. `window.ethereum` stays as a last resort for the plain injected
// case where no connector is available yet.
//
// The parameter is REQUIRED even though it accepts undefined, and that is the
// whole point: `getWalletProvider()` compiled fine and silently meant "use
// whatever extension is installed". Payroll signing called it that way. For a
// merchant signed in with Google that skipped their Circle wallet entirely and
// went to MetaMask — which opens the extension nobody asked to open, and, if
// approved, would have paid everybody's salary out of the owner's personal
// wallet instead of the business's settlement wallet.
//
// Making it required does not stop a caller passing undefined; it stops a
// caller passing NOTHING BY ACCIDENT. `undefined` here is now a sentence
// somebody wrote on purpose, and tsc names every site that has to write it.
export async function getWalletProvider(
  connector: Connector | undefined
): Promise<Eip1193Provider> {
  if (connector?.getProvider) {
    const provider = (await connector.getProvider()) as Eip1193Provider | undefined;
    if (provider) return provider;
  }

  const injected = (globalThis as unknown as { ethereum?: Eip1193Provider }).ethereum;
  if (injected) return injected;

  throw new Error(
    "No wallet is connected. Connect a wallet or sign in with Google, then try again."
  );
}
