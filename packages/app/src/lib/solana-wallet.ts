// Minimal Phantom-injected-provider integration, mirroring how PayConfirm.tsx
// already talks to window.ethereum directly for EVM rather than pulling in a
// full wallet-adapter framework. Solana wallets (Phantom, Solflare, Backpack)
// all inject window.solana with this same shape.
import { Connection, Transaction } from "@solana/web3.js";

const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";

interface SolanaProvider {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect(): Promise<{ publicKey: { toString(): string } }>;
  signTransaction(tx: Transaction): Promise<Transaction>;
}

export function getSolanaProvider(): SolanaProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { solana?: SolanaProvider };
  return w.solana?.isPhantom ? w.solana : null;
}

export async function connectSolanaWallet(): Promise<string> {
  const provider = getSolanaProvider();
  if (!provider) {
    throw new Error("No Solana wallet found. Install Phantom to bridge from Solana.");
  }
  const { publicKey } = await provider.connect();
  return publicKey.toString();
}

// Countersigns the unsigned (payer-signature-missing) burn transaction the
// API returned and submits it directly to Solana devnet -- Conduit never
// sees or holds the payer's Solana signing key, only the resulting
// transaction signature (which becomes the CCTP source_tx_hash).
export async function signAndSubmitBurn(unsignedTxBase64: string): Promise<string> {
  const provider = getSolanaProvider();
  if (!provider) {
    throw new Error("No Solana wallet found. Install Phantom to bridge from Solana.");
  }
  const tx = Transaction.from(Buffer.from(unsignedTxBase64, "base64"));
  const signedTx = await provider.signTransaction(tx);

  const connection = new Connection(SOLANA_DEVNET_RPC, "confirmed");
  const signature = await connection.sendRawTransaction(signedTx.serialize());
  await connection.confirmTransaction(signature, "confirmed");
  return signature;
}
