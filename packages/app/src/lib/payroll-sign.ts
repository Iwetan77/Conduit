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
): Promise<string> {
  const { ethers } = await import("ethers");
  // The BUSINESS's wallet, not the person's.
  //
  // Salaries come out of the settlement wallet, which for a Google merchant is
  // a different Circle wallet from the one they signed in with -- same user,
  // same token, different wallet_id. Asking for the plain connected provider
  // signed as the owner personally, which is the wrong account's money for a
  // screen that says the business is paying. See lib/settlement-signer.
  const { getSettlementProvider } = await import("@/lib/settlement-signer");
  const provider = new ethers.BrowserProvider(
    await getSettlementProvider(connector, settleAddress),
  );
  const signer = await provider.getSigner();

  // Exactly the total, not an unlimited allowance. A leftover approval on a
  // contract that moves salaries is a standing permission nobody remembers
  // granting, and this contract needs none between runs — it pulls and pushes
  // inside one call.
  const token = new ethers.Contract(leg.token, ERC20_ABI, signer);
  const approve = await token["approve"](spender, BigInt(leg.total));
  await approve.wait();

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
