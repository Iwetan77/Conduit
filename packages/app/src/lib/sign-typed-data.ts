import type { Eip1193Provider } from "ethers";

// StableFX hands back raw EIP-712 payloads (from Circle) that the payer must
// sign with their own wallet — twice: once over the quote, once over the
// funding message. Conduit never holds the key; these signatures are the only
// authority that moves the payer's funds.
export interface TypedDataPayload {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  message?: Record<string, unknown>;
  value?: Record<string, unknown>;
  primaryType?: string;
}

// `wallet` is the connected wallet's EIP-1193 provider (see lib/wallet-provider).
// It must be passed in rather than read off window.ethereum: Privy embedded
// wallets never inject there, and with several extensions installed the
// injected one may not be the account the payer is actually paying from.
export async function signTypedDataWithWallet(
  payload: unknown,
  wallet: Eip1193Provider
): Promise<string> {
  const { ethers } = await import("ethers");
  if (!wallet) throw new Error("No wallet found in this browser.");

  const td = (typeof payload === "string" ? JSON.parse(payload) : payload) as TypedDataPayload;
  if (!td?.domain || !td?.types) {
    throw new Error("The FX provider returned an unsigned-able payload.");
  }

  // ethers derives EIP712Domain from `domain` and rejects it being passed
  // explicitly, but Circle includes it in `types`.
  const { EIP712Domain: _omit, ...types } = td.types as Record<string, unknown>;
  const message = td.message ?? td.value;
  if (!message) throw new Error("The FX provider returned a payload with no message.");

  const provider = new ethers.BrowserProvider(wallet);
  const signer = await provider.getSigner();
  return signer.signTypedData(
    td.domain,
    types as Record<string, Array<{ name: string; type: string }>>,
    message
  );
}

// Which address a signature actually recovers to.
//
// Circle recovers the signer itself and rejects the trade if it doesn't match
// the address we registered (error 3015). What a provider reports as its
// account and what it ultimately signs with are not guaranteed to agree —
// observed with the Privy embedded wallet, where external wallets settled
// fine and the embedded one failed 3015 every time. Recovering locally makes
// the signer knowable instead of assumed, so the address we register can be
// the one Circle will compute.
export async function recoverTypedDataSigner(
  payload: unknown,
  signature: string
): Promise<string | undefined> {
  try {
    const { ethers } = await import("ethers");
    const td = (typeof payload === "string" ? JSON.parse(payload) : payload) as TypedDataPayload;
    const { EIP712Domain: _omit, ...types } = td.types as Record<string, unknown>;
    const message = td.message ?? td.value;
    if (!message) return undefined;
    return ethers.verifyTypedData(
      td.domain,
      types as Record<string, Array<{ name: string; type: string }>>,
      message,
      signature
    );
  } catch {
    // A smart-contract wallet's signature isn't ECDSA-recoverable at all.
    // Returning undefined keeps the caller on its existing path rather than
    // turning an unverifiable signature into a hard failure here.
    return undefined;
  }
}
