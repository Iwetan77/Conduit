// The Circle StableFX settlement flow, in one place so the payer checkout
// (/pay) and direct send (/send) cannot drift apart.
//
// Five steps, two of which are wallet signatures the payer makes themselves —
// Conduit never holds their key:
//
//   1. quote    — ask Circle what the conversion costs, get EIP-712 payload
//   2. sign     — payer authorises the quote
//   3. prepare  — Circle creates the trade, returns the funding payload
//   4. sign     — payer authorises the funding
//   5. confirm  — Circle's maker executes and delivers to the recipient
//
// This is the ONLY working cross-currency route. The old on-chain AMM path
// had no USDC/EURC pool on Arc testnet and could never settle.

import type { Connector } from "wagmi";

export interface FxCheckoutResult {
  txHash: string;
  rate: string;
  payAmount: string;
}

export async function runFxCheckout(
  intentId: string,
  payCurrency: string,
  onStage: (stage: string) => void,
  connector?: Connector
): Promise<FxCheckoutResult> {
  const { quoteSettlementIntent, prepareSettlementIntent, confirmSettlementIntent } = await import(
    "@/lib/conduit-api"
  );
  const { signTypedDataWithWallet } = await import("@/lib/sign-typed-data");
  const { getWalletProvider } = await import("@/lib/wallet-provider");

  // Resolve the connected wallet once, up front: both signatures must come
  // from the same account the payment is funded from.
  const wallet = await getWalletProvider(connector);

  onStage("Getting a rate from Circle StableFX…");
  const quote = await quoteSettlementIntent(intentId, payCurrency);
  if (!quote.typed_data) {
    throw new Error("The FX provider returned no payload to sign.");
  }

  onStage(`Rate ${quote.rate} — approve the quote in your wallet`);
  const quoteSignature = await signTypedDataWithWallet(quote.typed_data, wallet);

  onStage("Creating the trade…");
  const prep = await prepareSettlementIntent(intentId, quote.typed_data, quoteSignature);

  onStage("Approve the transfer in your wallet");
  const fundingSignature = await signTypedDataWithWallet(prep.funding_typed_data, wallet);

  onStage("Circle is settling to the recipient…");
  const res = await confirmSettlementIntent(intentId, fundingSignature);

  return { txHash: res.tx_hash ?? "", rate: quote.rate, payAmount: quote.pay_amount };
}
