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
export async function getWalletProvider(
  connector?: Connector
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
