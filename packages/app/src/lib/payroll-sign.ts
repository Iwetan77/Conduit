"use client";

// Signing one currency group's payroll.
//
// Two transactions, in this order: approve the total, then disperse it. One
// approve per run rather than one per person is the entire reason the batch
// contract exists — a business approves a figure it can read, once, instead of
// authorising a contract repeatedly.
//
// Both go through the connected wallet, which for a Circle merchant means the
// contract-execution challenge path. Nothing on the server can sign these.
//
// Loaded on demand from the payroll page: ethers is large and only needed at
// the moment somebody actually pays.
import type { Connector } from "wagmi";
import type { PayrollLeg } from "@/lib/conduit-api";

const ERC20_ABI = ["function approve(address spender, uint256 amount) returns (bool)"];
const PAYROLL_ABI = [
  "function disperse(bytes32 runId, address token, address[] to, uint256[] amounts) returns (uint256)",
];

/**
 * Convert the treasury into a leg's currency, on the way to paying it.
 *
 * A merchant holding USDC with a EURC-paid employee has to acquire EURC before
 * the batch contract can move any. The API has always reported this as
 * `needs_conversion` and the browser has always stopped there, so the feature
 * was advertised in the UI and absent from the code: the leg reached a wallet
 * prompt that could not succeed and reverted on insufficient balance, reported
 * as a generic wallet failure.
 *
 * Done HERE, in the browser, immediately before the approve — not on the
 * server. A StableFX quote lives about three and a half seconds, which does not
 * survive a server round trip plus a human reading a prompt. The payer and the
 * recipient are both the merchant: this buys EURC with USDC and settles it to
 * the business's own address, which is a settlement intent like any other and
 * needs no special case in fx-checkout.
 */
async function convertForLeg(
  leg: PayrollLeg,
  treasuryCurrency: string,
  settleAddress: string,
  connector: Connector | undefined,
  onStage: (stage: string) => void,
): Promise<void> {
  const { createSettlementIntent } = await import("@/lib/conduit-api");
  const { runFxCheckout } = await import("@/lib/fx-checkout");

  onStage(`converting ${treasuryCurrency} into ${leg.currency}…`);

  // Settling to the merchant's OWN address, in the leg's currency, for exactly
  // the leg total. Not a penny more: leftover foreign currency sitting in a
  // treasury is a balance nobody chose to hold and nobody is watching.
  //
  // settle_address is NOT sent, and that is deliberate rather than an omission.
  // This route derives it from the account, and for a merchant that derivation
  // IS the settle address -- the same value this function was passing. Sending
  // it was refused outright ("settle_address is derived from the account and
  // can no longer be set on this request"), which is what made every payroll
  // run fail at its conversion leg. Deriving it is also the safer of the two:
  // the destination of a business's own conversion should come from the
  // account, not from whatever the browser believed a moment ago.
  const intent = await createSettlementIntent({
    amount: leg.total,
    settle_currency: leg.currency,
    accept_currencies: [treasuryCurrency],
    reference: `payroll conversion ${leg.run_id_hash}`,
  });

  await runFxCheckout(intent.id, treasuryCurrency, onStage, connector, settleAddress);
}

/**
 * Pays one leg and returns the disperse transaction hash.
 *
 * `connector` is wagmi's, and it is not optional in practice even though the
 * type allows undefined. This asked for the provider with no connector at all,
 * which falls back to `window.ethereum` — so a merchant signed in with Google
 * had their payroll routed to whichever extension was installed rather than to
 * their Circle wallet. Two things went wrong at once there: an extension window
 * opened that nobody asked for, and had it been approved, everybody's salary
 * would have come out of the owner's personal wallet instead of the business's
 * settlement wallet.
 *
 * Throws with whatever the wallet said if either step is refused — the caller
 * records that as the group's failure reason, and a person reading it needs the
 * real cause rather than "something went wrong".
 */
export async function payPayrollLeg(
  spender: string,
  leg: PayrollLeg,
  connector: Connector | undefined,
  settleAddress: string,
  treasuryCurrency: string,
  onStage: (stage: string) => void = () => {},
): Promise<string> {
  // Convert first, if this leg is not in the currency the treasury holds.
  //
  // Before the approve, deliberately. Approving and then discovering there is
  // nothing to approve AN ALLOWANCE OVER costs the merchant a signature and a
  // transaction fee for a run that was never going to work.
  if (leg.currency !== treasuryCurrency) {
    await convertForLeg(leg, treasuryCurrency, settleAddress, connector, onStage);
  }

  const { ethers } = await import("ethers");
  // The BUSINESS's wallet, not the person's.
  //
  // Salaries come out of the settlement wallet, which for a Google merchant is
  // a different Circle wallet from the one they signed in with -- same user,
  // same token, different wallet_id. Asking for the plain connected provider
  // signed as the owner personally, which is the wrong account's money for a
  // screen that says the business is paying. See lib/settlement-signer.
  const { getSettlementProvider } = await import("@/lib/settlement-signer");
  const { browserProviderFrom } = await import("@/lib/wallet-provider");
  const provider = await browserProviderFrom(
    await getSettlementProvider(connector, settleAddress),
  );
  const signer = await provider.getSigner();

  // Exactly the total, not an unlimited allowance. A leftover approval on a
  // contract that moves salaries is a standing permission nobody remembers
  // granting, and this contract needs none between runs — it pulls and pushes
  // inside one call.
  onStage("waiting for you to approve the transfer…");
  const token = new ethers.Contract(leg.token, ERC20_ABI, signer);
  const approve = await token["approve"](spender, BigInt(leg.total));
  await approve.wait();

  onStage("paying…");

  const payroll = new ethers.Contract(spender, PAYROLL_ABI, signer);
  const tx = await payroll["disperse"](
    leg.run_id_hash,
    leg.token,
    leg.recipients,
    leg.amounts.map((a) => BigInt(a)),
  );
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error("the payroll transaction reverted; nobody in this group was paid");
  }
  return receipt.hash as string;
}
