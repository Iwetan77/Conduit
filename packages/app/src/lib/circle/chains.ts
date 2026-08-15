"use client";

// Circle blockchain identifiers ↔ EVM chain ids, for the chains the
// cross-chain payer flow can source USDC from.
//
// A Circle user-controlled wallet is provisioned PER BLOCKCHAIN, so paying
// from USDC held on Base means holding a Circle wallet on Base — one on Arc
// cannot do it. This table is what lets the provider answer
// wallet_switchEthereumChain by swapping which wallet it signs with, which is
// the whole mechanism behind cross-chain pay for a Google sign-in.
//
// Sonic, World Chain, Sei and HyperEVM appear in SOURCE_CHAINS but Circle
// cannot hold a wallet on them, so they are absent here on purpose: a Circle
// user genuinely cannot pay from those chains, and pretending otherwise would
// fail somewhere much less legible than the chain picker.
//
// This list must stay in step with Blockchains in server.go, which is what
// provisions the wallets. A chain here with no wallet behind it fails at the
// switch; a wallet with no entry here can never be switched to.

import { ARC_RPC_URL } from "@/lib/chain";

export interface CircleChain {
  /** Circle's blockchain identifier, as returned on a wallet. */
  circle: string;
  /** EVM chain id. */
  id: number;
  /** Public RPC for reads while the wallet is on this chain. */
  rpc: string;
  label: string;
}

export const CIRCLE_CHAINS: readonly CircleChain[] = [
  // Arc's RPC comes from lib/chain, not a literal. It was hardcoded to the
  // public endpoint here, so setting NEXT_PUBLIC_ARC_RPC_URL configured every
  // read in the app EXCEPT the ones this provider makes -- and the whole reason
  // that variable exists is that the public endpoint is Cloudflare-fronted and
  // rate-limits browsers.
  { circle: "ARC-TESTNET", id: 5042002, rpc: ARC_RPC_URL, label: "Arc Testnet" },
  {
    circle: "ETH-SEPOLIA",
    id: 11155111,
    rpc: "https://ethereum-sepolia-rpc.publicnode.com",
    label: "Ethereum Sepolia",
  },
  { circle: "BASE-SEPOLIA", id: 84532, rpc: "https://sepolia.base.org", label: "Base Sepolia" },
  { circle: "MATIC-AMOY", id: 80002, rpc: "https://rpc-amoy.polygon.technology", label: "Polygon Amoy" },
  { circle: "AVAX-FUJI", id: 43113, rpc: "https://api.avax-test.network/ext/bc/C/rpc", label: "Avalanche Fuji" },
  { circle: "ARB-SEPOLIA", id: 421614, rpc: "https://sepolia-rollup.arbitrum.io/rpc", label: "Arbitrum Sepolia" },
  { circle: "OP-SEPOLIA", id: 11155420, rpc: "https://sepolia.optimism.io", label: "OP Sepolia" },
  { circle: "UNI-SEPOLIA", id: 1301, rpc: "https://sepolia.unichain.org", label: "Unichain Sepolia" },
];

export function chainByCircleId(circle: string): CircleChain | undefined {
  return CIRCLE_CHAINS.find((c) => c.circle === circle);
}

export function chainByEvmId(id: number): CircleChain | undefined {
  return CIRCLE_CHAINS.find((c) => c.id === id);
}
