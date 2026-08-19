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

import { useCallback, useEffect, useState } from "react";
import { useAccount, useDisconnect } from "wagmi";
import { CIRCLE_CONNECTOR_ID } from "@/lib/circle/connector";
import {
  connectSolanaWallet,
  disconnectSolanaWallet,
  getSolanaProvider,
  listSolanaWallets,
  type SolanaWalletOption,
} from "@/lib/solana-wallet";

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

  const [solanaAddress, setSolanaAddress] = useState<string | null>(null);
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

  // Reflect a Solana wallet that is already connected -- returning to the page
  // with the extension still authorised should not look like being signed out.
  useEffect(() => {
    const pk = getSolanaProvider()?.publicKey;
    if (pk) setSolanaAddress(pk.toString());
  }, [solanaWallets]);

  const connectSolana = useCallback(async (choice?: SolanaWalletOption) => {
    setConnecting(true);
    setError("");
    try {
      const address = await connectSolanaWallet(choice?.provider);
      setSolanaAddress(address);
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
      setSolanaAddress(null);
    }
    if (evmConnected) {
      try {
        await disconnectAsync();
      } catch {
        // A connector that refuses to disconnect must not strand the payer.
      }
    }
  }, [solanaAddress, evmConnected, disconnectAsync]);

  // Solana wins when both are present, with one exception.
  //
  // Connecting a Solana wallet is an explicit act -- an EVM wallet is often
  // just auto reconnected from a previous visit -- so the deliberate choice is
  // the one to honour. Picking Solana also says something specific: the payer
  // means to spend Solana USDC.
  //
  // The exception is a Circle session. That is a signed-in merchant, and their
  // wallet is their identity across the whole dashboard; letting a browser
  // extension outrank it would show a merchant somebody else's address in
  // their own nav, next to the links and settlements belonging to the account
  // they are actually signed in as.
  const signedInWithGoogle = evmConnected && connector?.id === CIRCLE_CONNECTOR_ID;
  let identity: PayerIdentity | null = null;
  if (solanaAddress && !signedInWithGoogle) {
    identity = { kind: "solana", address: solanaAddress, canSettleOnArc: false };
  } else if (evmConnected && evmAddress) {
    identity = { kind: "evm", address: evmAddress, chainId, canSettleOnArc: true };
  }

  return { identity, solanaWallets, connectSolana, disconnect, connecting, error };
}
