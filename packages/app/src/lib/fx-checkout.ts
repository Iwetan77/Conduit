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

// Refuse a payment the payer demonstrably cannot fund, before either
// signature. Reads the token balance straight from Arc rather than trusting a
// cached UI value, since this is the check that decides whether to ask someone
// to sign.
//
// A read failure is NOT treated as insufficient: Arc's public RPC rate-limits,
// and blocking a well-funded payer because one eth_call got a 429 would be a
// worse bug than the one this fixes. Circle still rejects genuinely unfundable
// trades; this exists to say so clearly and early.
async function assertCanAfford(
  payerAddress: string,
  payCurrency: string,
  payAmount: string
): Promise<void> {
  try {
    const { ethers } = await import("ethers");
    const { arcReadProvider } = await import("@/lib/arc-provider");
    const { CURRENCIES } = await import("@conduit/sdk/lite");
    const { formatAmount } = await import("@/lib/format");

    const token = CURRENCIES[payCurrency as keyof typeof CURRENCIES]?.token;
    if (!token) return;

    const erc20 = new ethers.Contract(
      token,
      ["function balanceOf(address) view returns (uint256)"],
      arcReadProvider()
    );
    const balance = (await erc20.balanceOf(payerAddress)) as bigint;
    const needed = BigInt(payAmount);
    if (balance >= needed) return;

    const cur = payCurrency as Parameters<typeof formatAmount>[1];
    throw new InsufficientFundsError(
      `This payment needs ${formatAmount(needed, cur)} ${payCurrency}, but this wallet holds ${formatAmount(balance, cur)}.`
    );
  } catch (err) {
    if (err instanceof InsufficientFundsError) throw err;
    // Any other failure here is a balance-read problem, not a funding problem.
  }
}

export class InsufficientFundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientFundsError";
  }
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
  const { signTypedDataWithWallet, recoverTypedDataSigner } = await import(
    "@/lib/sign-typed-data"
  );
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
  let payerAddress = accounts?.[0];
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

    // The only point where the exact cost is known: the quote priced it, and
    // nothing has been signed yet. Cross-currency has no pre-quote, so the
    // balance guard on the input screen sits out this path entirely — without
    // this check, overspending sailed through both signatures and died deep
    // inside Circle as "never got a contractTradeId", which reached the payer
    // as "the FX provider is temporarily unavailable". It was never the
    // provider; the taker leg simply couldn't be funded.
    await assertCanAfford(payerAddress, payCurrency, quote.pay_amount);

    onStage(`Rate ${quote.rate} — approve the quote in your wallet`);
    const quoteSignature = await signTypedDataWithWallet(quote.typed_data, wallet);

    // What a wallet reports as its account and what it signs with can differ.
    // Circle recovers the signer and rejects the trade if it doesn't match the
    // address we registered (3015) -- which is why external wallets settled
    // and the Privy embedded wallet never did. Recover locally; if it isn't
    // who we registered, re-quote against the real signer and go again.
    const signedBy = await recoverTypedDataSigner(quote.typed_data, quoteSignature);
    if (signedBy && signedBy.toLowerCase() !== payerAddress.toLowerCase() && attempt < 2) {
      payerAddress = signedBy;
      continue;
    }

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
