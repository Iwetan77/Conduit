// Minimal Phantom-injected-provider integration, mirroring how PayConfirm.tsx
// already talks to window.ethereum directly for EVM rather than pulling in a
// full wallet-adapter framework. Solana wallets (Phantom, Solflare, Backpack)
// all inject window.solana with this same shape.
// TYPE-only at module scope. @solana/web3.js is ~11 MB and was being pulled
// into the /pay checkout bundle for every payer, including the large
// majority who never touch the cross-chain path. The two values actually
// needed (Connection, Transaction) are imported inside the one function that
// uses them, so the package now loads only when a Solana deposit is signed.
import type { Connection, Transaction } from "@solana/web3.js";

const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";

interface SolanaProvider {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect(): Promise<{ publicKey: { toString(): string } }>;
  signTransaction(tx: Transaction): Promise<Transaction>;
  signMessage(message: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array }>;
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

// Countersigns the deposit transaction the API returned (only needed when
// the payer's Gateway balance can't cover this payment yet) and submits it
// directly to Solana devnet. Conduit never sees or holds the payer's Solana
// signing key, only the resulting transaction signature.
export async function signAndSubmitDeposit(unsignedTxBase64: string): Promise<string> {
  const provider = getSolanaProvider();
  if (!provider) {
    throw new Error("No Solana wallet found. Install Phantom to bridge from Solana.");
  }
  const { Connection: SolConnection, Transaction: SolTransaction } = await import("@solana/web3.js");
  const tx = SolTransaction.from(Buffer.from(unsignedTxBase64, "base64"));
  const signedTx = await provider.signTransaction(tx);

  const connection = new SolConnection(SOLANA_DEVNET_RPC, "confirmed");
  const signature = await connection.sendRawTransaction(signedTx.serialize());
  await connection.confirmTransaction(signature, "confirmed");
  return signature;
}

// Gateway's burn intent is a signed off-chain message, not a transaction --
// there is nothing to submit to Solana here. This calls Phantom's
// signMessage (ed25519 over the raw bytes) and returns a 0x-prefixed hex
// signature for the API's burn_intent_signature field. See
// docs/ubk-capability.md for the byte-exact encoding these bytes carry.
export async function signBurnIntent(burnIntentMessageHex: string): Promise<string> {
  const provider = getSolanaProvider();
  if (!provider) {
    throw new Error("No Solana wallet found. Install Phantom to bridge from Solana.");
  }
  const bytes = hexToBytes(burnIntentMessageHex);
  const { signature } = await provider.signMessage(bytes, "utf8");
  return "0x" + Buffer.from(signature).toString("hex");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes;
}
