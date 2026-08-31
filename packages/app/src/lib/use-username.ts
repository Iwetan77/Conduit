"use client";

// Who the signed-in person is, by name.
//
// Two ways to hold a username, because there are two ways to be signed in:
//
//   A merchant or Google user has a SESSION, so their account -- and its
//   username -- comes back on /accounts/me.
//
//   A payer with only an EVM wallet has no session at all; their account is
//   created lazily the first time they send. For them the name is looked up
//   from the wallet address.
//
// One hook answers for both, so no surface has to know which kind of person is
// looking at it.
//
// Solana is excluded by design, not by omission. A username has to bind to an
// address Conduit can settle to on Arc, and a Solana wallet cannot sign for
// one -- so there is no honest way to hold the name, and asking for it would
// promise something that could never work.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSessionToken, getUsernameForWallet } from "@/lib/conduit-api";
import { useMyAccount } from "@/lib/queries";
import { usePayerIdentity } from "@/lib/use-payer-identity";
import { useHydrated } from "@/lib/use-hydrated";

export const usernameQk = {
  byWallet: (address?: string) => ["username", "wallet", address?.toLowerCase()] as const,
};

/**
 * Asks the gate to open the naming prompt.
 *
 * An event rather than shared state, matching how sign-in already works here
 * (see wallet-gate): the button that asks and the component that renders are on
 * opposite sides of the tree, and neither should have to know the other exists.
 */
export const USERNAME_PROMPT_EVENT = "conduit:set-username";

export function requestUsernamePrompt() {
  window.dispatchEvent(new Event(USERNAME_PROMPT_EVENT));
}

export interface UsernameState {
  /** The claimed name, or null when there isn't one yet. */
  username: string | null;
  /** True while either lookup is still outstanding. */
  loading: boolean;
  /**
   * Whether this person CAN hold a username at all.
   *
   * False for a Solana wallet and for nobody-signed-in. Surfaces must check
   * this before prompting: asking someone to pick a name that cannot be bound
   * to them is worse than not offering the feature.
   */
  eligible: boolean;
  /** True when they are eligible, settled, and have not claimed one. */
  shouldPrompt: boolean;
}

export function useUsername(): UsernameState {
  const { identity } = usePayerIdentity();
  // Hydration-guarded: the token lives in browser storage, so the server render
  // must not branch on it or the two renders disagree.
  const hydrated = useHydrated();
  // A session means a merchant/Google account, which carries its own username.
  const session = hydrated && !!getSessionToken();
  const account = useMyAccount(session);

  const isEvm = identity?.kind === "evm";
  const walletAddress = isEvm ? identity?.address : undefined;
  // Run for a signed-in wallet too, not only a session-less one.
  //
  // It was gated on `!session` on the theory that /accounts/me is the authority
  // when there is one. It is the authority for THAT account -- and the account
  // the session points at is not always the one holding the name. Somebody
  // signed in with Google whose name was claimed against their own wallet's
  // personal account saw /accounts/me return null and kept the anonymous dot in
  // the nav, having just claimed a username.
  //
  // Both are asked now and the session answer still wins when it has one; this
  // only fills the gap where it does not.
  const walletLookup = useQuery({
    queryKey: usernameQk.byWallet(walletAddress),
    queryFn: () => getUsernameForWallet(walletAddress!),
    enabled: !!walletAddress,
    // A name is claimed once and never changes, so there is nothing to poll
    // for. Refetching on focus would be a request per tab switch for an answer
    // that cannot have moved.
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });

  const eligible = session || isEvm;

  if (session) {
    // The signed-in account is authoritative for ITSELF, and the wallet answer
    // is only allowed to fill in for it when the wallet is demonstrably the
    // same person's.
    //
    // It used to fall back unconditionally, to cover a real case: someone
    // signed in with Google whose name was claimed against their own wallet's
    // personal account saw /accounts/me return null and kept the anonymous dot.
    // But "a wallet is connected" is not "this wallet is mine" -- an external
    // wallet stays connected across sign-ins, and a stale address survives a
    // switch for a moment. So the name claimed on one person's wallet appeared
    // on every account signed into afterwards on that device. Somebody else's
    // name on your account is worse than no name on your own.
    //
    // Matching login_wallet is exactly the condition the original fix meant:
    // the wallet the signed-in account signs in WITH.
    const ownsWallet =
      !!walletAddress &&
      !!account.data?.login_wallet &&
      account.data.login_wallet.toLowerCase() === walletAddress.toLowerCase();
    const username = account.data?.username ?? (ownsWallet ? walletLookup.data ?? null : null);
    const settled = !account.isLoading && (!walletAddress || !walletLookup.isLoading);
    return {
      username,
      loading: !settled,
      eligible: true,
      // Only once BOTH have answered. Prompting on the session's null while the
      // wallet lookup is still in flight asks someone to claim a name they may
      // already hold.
      shouldPrompt: settled && !!account.data && username === null,
    };
  }

  if (!isEvm) {
    // Solana, or nothing connected. Never prompt.
    return { username: null, loading: false, eligible: false, shouldPrompt: false };
  }

  const username = walletLookup.data ?? null;
  return {
    username,
    loading: walletLookup.isLoading,
    eligible,
    // isSuccess, not "data is null": a failed lookup also yields null, and
    // prompting someone to claim a name because the network hiccuped is how
    // they end up staring at a form they already filled in.
    shouldPrompt: walletLookup.isSuccess && username === null,
  };
}

/**
 * Drop the cached name after a claim, so every surface picks it up at once.
 *
 * Without this the chip in the nav keeps showing an address until a reload,
 * which reads as the claim having failed.
 */
export function useInvalidateUsername() {
  const qc = useQueryClient();
  return (address?: string) => {
    void qc.invalidateQueries({ queryKey: usernameQk.byWallet(address) });
    void qc.invalidateQueries({ queryKey: ["account", "me"] });
  };
}
