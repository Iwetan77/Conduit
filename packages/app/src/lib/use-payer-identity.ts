"use client";

// Who is paying, regardless of which wallet family they brought.
//
// /send has always keyed off wagmi's isConnected, and wagmi has no concept of
// Solana. That single assumption is why "Pay with USDC from another chain" had
// to exist as a separate door: a payer whose USDC sits on Solana has no EVM
// wallet to connect, so the ordinary Send button was unreachable for them and
// the cross chain button was deliberately placed outside the connect gate.
//
// This is the layer that removes the assumption. wagmi still owns EVM
// entirely; nothing about the existing connect flow changes. Solana is added
// beside it and the two are presented as one answer to one question: who is
// paying, and what can they actually do.
//
// The families are NOT equivalent, and the type says so rather than leaving
// callers to remember. An EVM wallet can settle directly on Arc and can source
// from every Gateway chain. A Solana wallet can do exactly one thing: fund a
// payment through Gateway. It cannot sign anything on Arc, so any UI that
// offers it an Arc route is offering a button that cannot work.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useAccount, useDisconnect } from "wagmi";
import { CIRCLE_CONNECTOR_ID } from "@/lib/circle/connector";
import {
  connectSolanaWallet,
  eagerConnectSolanaWallet,
  disconnectSolanaWallet,
  getSolanaProvider,
  listSolanaWallets,
  type SolanaWalletOption,
} from "@/lib/solana-wallet";

// The connected Solana wallet, held ONCE for the whole page.
//
// This was per-hook React state, which is wrong for a fact about the browser:
// the nav connected a wallet and set its own copy, while the send page's copy
// stayed null and kept asking the payer to connect a wallet they were plainly
// already connected to -- visible in the same screenshot, connected top right
// and requested in the middle. Every instance now reads one store.
let solanaAddr: string | null = null;
let pickedSolanaGlobal = false;
const listeners = new Set<() => void>();
function emit() {
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
function snapshot() {
  return solanaAddr;
}
function setSolanaAddr(v: string | null, picked: boolean) {
  solanaAddr = v;
  pickedSolanaGlobal = picked;
  emit();
}

export type PayerFamily = "evm" | "solana";

export interface PayerIdentity {
  kind: PayerFamily;
  address: string;
  /** The EVM chain the wallet reports. Always undefined for Solana. */
  chainId?: number;
  /**
   * Can this wallet sign a transaction on Arc?
   *
   * True for EVM only. Drives whether a direct settle is even offered: a
   * Solana payer's only route is Gateway, and that is a property of the
   * wallet, not of where their money happens to sit.
   */
  canSettleOnArc: boolean;
  /**
   * Can this wallet authorise a Circle Gateway burn intent?
   *
   * False for Phantom, which refuses to signMessage a transaction shaped
   * payload -- the exact shape Gateway uses. Carried on the identity because
   * the check has to happen where the wallet is CHOSEN, not where the payment
   * is signed: Circle's SDK retries the refusal until it exhausts, and the
   * resulting "maximum retry attempts" is indistinguishable from Circle being
   * down. A payer then gets told to wait and try again, forever.
   */
  gatewayCapable: boolean;
}

export interface UsePayerIdentity {
  identity: PayerIdentity | null;
  /** Solana wallets detected in this browser. Empty until mounted. */
  solanaWallets: SolanaWalletOption[];
  connectSolana: (choice?: SolanaWalletOption) => Promise<void>;
  /** Disconnects whichever family is connected. */
  disconnect: () => Promise<void>;
  connecting: boolean;
  error: string;
}

export function usePayerIdentity(): UsePayerIdentity {
  const { address: evmAddress, isConnected: evmConnected, chainId, connector } = useAccount();
  const { disconnectAsync } = useDisconnect();

  // Shared across every instance, so the nav and the page cannot disagree.
  const solanaAddress = useSyncExternalStore(subscribe, snapshot, () => null);
  // True only when the payer chose a Solana wallet from the connect list in
  // this session. A wallet merely left authorised from a previous visit is
  // detected (below) but must not silently displace an EVM connection.
  const pickedSolana = pickedSolanaGlobal;
  const [solanaWallets, setSolanaWallets] = useState<SolanaWalletOption[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");

  // Discovery touches window, so it cannot run during render or on the server.
  // Re-run once shortly after mount: extensions inject asynchronously and a
  // wallet that registers late would otherwise be invisible for the life of
  // the page.
  useEffect(() => {
    const scan = () => setSolanaWallets(listSolanaWallets());
    scan();
    const t = setTimeout(scan, 800);
    return () => clearTimeout(t);
  }, []);

  // Restore the connection across a reload.
  //
  // publicKey alone is not enough: an extension leaves it null after a refresh
  // until the site reconnects, which is why every reload looked like a
  // disconnect. eagerConnectSolanaWallet asks the wallet to restore silently,
  // and only for the wallet the payer actually chose. A deliberate disconnect
  // forgets that choice, so it stays disconnected.
  useEffect(() => {
    if (solanaAddr) return;
    const pk = getSolanaProvider()?.publicKey;
    if (pk) {
      setSolanaAddr(pk.toString(), false);
      return;
    }
    let cancelled = false;
    void eagerConnectSolanaWallet().then((addr) => {
      if (!cancelled && addr && !solanaAddr) setSolanaAddr(addr, false);
    });
    return () => {
      cancelled = true;
    };
  }, [solanaWallets, solanaAddress]);

  const connectSolana = useCallback(async (choice?: SolanaWalletOption) => {
    setConnecting(true);
    setError("");
    try {
      const address = await connectSolanaWallet(choice?.provider);
      setSolanaAddr(address, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect that wallet.");
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    // Both, unconditionally. Someone who has connected each at some point
    // expects "disconnect" to mean disconnected, not to leave the other family
    // quietly attached and paying.
    if (solanaAddress) {
      await disconnectSolanaWallet();
      setSolanaAddr(null, false);
    }
    if (evmConnected) {
      try {
        await disconnectAsync();
      } catch {
        // A connector that refuses to disconnect must not strand the payer.
      }
    }
  }, [solanaAddress, evmConnected, disconnectAsync]);

  // EVM is the default identity. Solana is never preferred.
  //
  // An earlier version had Solana outrank EVM on the theory that connecting it
  // is the more deliberate act. That is wrong in the case that matters: a
  // signed-in merchant whose browser also has Phantom would have found their
  // own nav showing somebody else's address, beside their own account's
  // settlements. Solana answers only when nothing else does, or when the payer
  // explicitly picked it in this session and no Circle session is in play.
  const signedInWithGoogle = evmConnected && connector?.id === CIRCLE_CONNECTOR_ID;
  let identity: PayerIdentity | null = null;
  if (evmConnected && evmAddress && (signedInWithGoogle || !pickedSolana)) {
    identity = {
      kind: "evm",
      address: evmAddress,
      chainId,
      canSettleOnArc: true,
      gatewayCapable: true,
    };
  } else if (solanaAddress) {
    // Which detected wallet is actually connected, so its capability travels
    // with the identity. Matched on the provider object rather than the label:
    // the label is the wallet's own string and can change, the object is the
    // thing we will be asking to sign.
    const active = getSolanaProvider();
    const option = solanaWallets.find((w) => w.provider === active);
    identity = {
      kind: "solana",
      address: solanaAddress,
      canSettleOnArc: false,
      // Unknown wallets are assumed capable, matching lib/solana-wallet: the
      // failure is loud and recoverable, whereas refusing an unlisted wallet
      // blocks one that probably works.
      gatewayCapable: option?.gatewayCapable ?? true,
    };
  }

  return { identity, solanaWallets, connectSolana, disconnect, connecting, error };
}
