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

  // Read the payer address off the very provider that is about to sign, rather
  // than accepting it from the caller. Circle recovers the signer from the
  // quote signature and rejects the trade if it doesn't match the address
  // registered on it, so these two must be the same account by construction —
  // passing it in separately is exactly the kind of drift that produced
  // "the provided signature could not be verified against the expected
  // address".
  const accounts = (await wallet.request({ method: "eth_accounts" })) as string[];
  const payerAddress = accounts?.[0];
  if (!payerAddress) {
    throw new Error("No wallet account is connected to sign this payment.");
  }

  // Circle's quotes live ~3.5-5s (docs/fx-capability.md) and a human takes
  // longer than that to read and approve a wallet prompt. So an expired quote
  // is a NORMAL outcome here, not an error: get a fresh rate and ask again,
  // showing the new number. Never silently reuse a stale one — the payer signs
  // the rate they were shown. docs/fx-timing.md calls for exactly this.
  let prep: { funding_typed_data: unknown } | undefined;
  let rate = "";
  let payAmount = "";

  for (let attempt = 0; attempt < 3 && !prep; attempt++) {
    onStage(attempt === 0 ? "Getting a rate from Circle StableFX…" : "Rate moved — getting a fresh one…");
    const quote = await quoteSettlementIntent(intentId, payCurrency, payerAddress);
    if (!quote.typed_data) {
      throw new Error("The FX provider returned no payload to sign.");
    }
    rate = quote.rate;
    payAmount = quote.pay_amount;

    onStage(`Rate ${quote.rate} — approve the quote in your wallet`);
    const quoteSignature = await signTypedDataWithWallet(quote.typed_data, wallet);

    onStage("Creating the trade…");
    // Circle wants the INNER message, not the whole EIP-712 envelope, even
    // though the signature is over the full envelope (domain + types +
    // message). Sending the envelope made Circle reject the trade, which the
    // API reported as the catch-all "FX provider is temporarily unavailable".
    // docs/quickstart.md's working flow does exactly this split.
    const quoteMessage =
      (quote.typed_data as { message?: unknown; value?: unknown }).message ??
      (quote.typed_data as { value?: unknown }).value;

    try {
      prep = await prepareSettlementIntent(intentId, quoteMessage, quoteSignature);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "fx_quote_expired" && attempt < 2) continue;
      throw err;
    }
  }

  if (!prep) {
    throw new Error(
      "The rate kept moving before the signature landed. Try again — approving a little faster usually does it."
    );
  }

  onStage("Approve the transfer in your wallet");
  const fundingSignature = await signTypedDataWithWallet(prep.funding_typed_data, wallet);

  onStage("Circle is settling to the recipient…");
  const res = await confirmSettlementIntent(intentId, fundingSignature);

  return { txHash: res.tx_hash ?? "", rate, payAmount };
}
