"use client";

// A signer for the BUSINESS's wallet, not the person's.
//
// A Conduit user has two Circle wallets: the one they signed in with, which is
// theirs personally, and the settlement wallet, which is the business's. Both
// belong to the same Circle user and both are reachable with the same user
// token — createSettlementWallet exists precisely because "Circle will happily
// hold more than one wallet per chain for a user".
//
// The merchant surfaces used to refuse instead of doing this, on the stated
// reasoning that "a Circle wallet's key material is on the owner's device and
// the session is bound to the wallet they signed in with, so being signed in as
// the business does NOT confer the ability to move the business wallet's
// money". That reasoning was wrong. The key material is bound to the USER, not
// to one of their wallets; Circle's transfer API takes a wallet_id and the
// user's token, and the settlement wallet is already in `session.wallets`. The
// capability was there the whole time — nothing knew how to ask for it.
//
// So Send and payroll now sign as the settlement wallet. A merchant paying
// staff presses send, and the money leaves the business's address, which is
// what both screens have always claimed they do.
import type { Connector } from "wagmi";
import type { Eip1193Provider } from "ethers";

/**
 * An EIP-1193 provider pinned to `settleAddress`.
 *
 * Refuses rather than falling back. A provider that quietly kept signing as the
 * personal wallet would spend the owner's own money under a screen that says
 * the business is paying — the failure this whole path exists to prevent — so
 * a wallet that is not in this session throws with what IS available.
 *
 * For an injected wallet (a merchant who connected MetaMask rather than signing
 * in with Google) there is nothing to pin: that wallet signs for one address
 * and it either is the settlement address or it cannot help. The check is the
 * same one the caller would have made, kept here so both callers make it the
 * same way.
 */
export async function getSettlementProvider(
  connector: Connector | undefined,
  settleAddress: string,
): Promise<Eip1193Provider> {
  const { getWalletProvider } = await import("@/lib/wallet-provider");
  const provider = await getWalletProvider(connector);

  try {
    await (provider as unknown as {
      request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
    }).request({ method: "conduit_useWallet", params: [settleAddress] });
    return provider;
  } catch (err) {
    // Not a Circle provider. An injected wallet answers "unsupported method"
    // to anything it does not know, which is not a failure — it just means the
    // only address it can sign for is the one already connected.
    const accounts = (await (provider as unknown as {
      request: (a: { method: string }) => Promise<unknown>;
    })
      .request({ method: "eth_accounts" })
      .catch(() => [])) as string[];

    const has = accounts.some((a) => a.toLowerCase() === settleAddress.toLowerCase());
    if (has) return provider;

    // A Circle provider that refused names the reason itself, and that reason
    // is more useful than anything this could invent.
    if (err instanceof Error && err.message.includes("not one of this sign-in's wallets")) {
      throw err;
    }
    throw new Error(
      `The connected wallet cannot sign for the settlement address ${settleAddress}. ` +
        `Sign in with Google as the account that owns it.`,
    );
  }
}
