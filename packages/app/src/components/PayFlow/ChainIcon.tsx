"use client";

// Brand marks for the chains a payer can source USDC from.
//
// A payer picking where their money is recognises a logo before they finish
// reading a word, and this list is twelve rows long. Names alone made it a
// wall of text.
//
// Imported one file per icon rather than from the package root: the root index
// pulls in every network AND token icon the library ships, which is hundreds of
// components in a bundle a payer downloads mid-payment. Each deep import is a
// single SVG.
//
// The mainnet mark is used for every testnet — Base Sepolia is Base's logo, and
// a payer looking for "where my USDC is" is looking for Base.

import type { SourceKind } from "@/lib/unified-balance";

import NetworkArbitrumOne from "@web3icons/react/icons/networks/NetworkArbitrumOne";
import NetworkAvalanche from "@web3icons/react/icons/networks/NetworkAvalanche";
import NetworkBase from "@web3icons/react/icons/networks/NetworkBase";
import NetworkEthereum from "@web3icons/react/icons/networks/NetworkEthereum";
import NetworkHyperEvm from "@web3icons/react/icons/networks/NetworkHyperEvm";
import NetworkOptimism from "@web3icons/react/icons/networks/NetworkOptimism";
import NetworkPolygon from "@web3icons/react/icons/networks/NetworkPolygon";
import NetworkSeiNetwork from "@web3icons/react/icons/networks/NetworkSeiNetwork";
import NetworkSolana from "@web3icons/react/icons/networks/NetworkSolana";
import NetworkSonic from "@web3icons/react/icons/networks/NetworkSonic";
import NetworkUnichain from "@web3icons/react/icons/networks/NetworkUnichain";
import NetworkWorld from "@web3icons/react/icons/networks/NetworkWorld";

// The library's own component type, taken from one of the icons rather than
// hand-written: every icon is built by the same factory, and a home-made prop
// type only has to drift by one field (size is string | number, not number) to
// stop compiling.
type Web3Icon = typeof NetworkBase;

const ICONS: Record<SourceKind, Web3Icon> = {
  solana: NetworkSolana,
  base: NetworkBase,
  polygon: NetworkPolygon,
  ethereum: NetworkEthereum,
  avalanche: NetworkAvalanche,
  optimism: NetworkOptimism,
  arbitrum: NetworkArbitrumOne,
  unichain: NetworkUnichain,
  sonic: NetworkSonic,
  worldchain: NetworkWorld,
  sei: NetworkSeiNetwork,
  hyperevm: NetworkHyperEvm,
};

export function ChainIcon({ kind, size = 20 }: { kind: SourceKind; size?: number }) {
  const Icon = ICONS[kind];
  if (!Icon) return null;
  // Branded, not mono: colour is most of what makes a chain recognisable at
  // 20px, and this list is scanned rather than read.
  return <Icon size={size} variant="branded" className="shrink-0" />;
}
