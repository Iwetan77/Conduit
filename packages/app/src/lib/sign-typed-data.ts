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

export async function signTypedDataWithWallet(payload: unknown): Promise<string> {
  const { ethers } = await import("ethers");
  const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  if (!eth) throw new Error("No wallet found in this browser.");

  const td = (typeof payload === "string" ? JSON.parse(payload) : payload) as TypedDataPayload;
  if (!td?.domain || !td?.types) {
    throw new Error("The FX provider returned an unsigned-able payload.");
  }

  // ethers derives EIP712Domain from `domain` and rejects it being passed
  // explicitly, but Circle includes it in `types`.
  const { EIP712Domain: _omit, ...types } = td.types as Record<string, unknown>;
  const message = td.message ?? td.value;
  if (!message) throw new Error("The FX provider returned a payload with no message.");

  const provider = new ethers.BrowserProvider(eth);
  const signer = await provider.getSigner();
  return signer.signTypedData(
    td.domain,
    types as Record<string, Array<{ name: string; type: string }>>,
    message
  );
}
