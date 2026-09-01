import type { Eip1193Provider } from "ethers";

// Must match packages/api/internal/handlers/usernames.go's
// usernameClaimMessage() byte-for-byte -- the server rebuilds this same string
// from (wallet, username, timestamp) and checks the signature against it, so
// nothing here is free text the server has to take on trust.
//
// The USERNAME is inside the message on purpose. A signature that covered only
// the wallet and a timestamp could be captured and replayed to claim a
// different name than the one the person approved.
function usernameClaimMessage(wallet: string, username: string, timestamp: number): string {
  return `Conduit: claim username\n\nUsername: ${username}\nWallet: ${wallet.toLowerCase()}\nTimestamp: ${timestamp}`;
}

/**
 * Sign a username claim with the connected wallet.
 *
 * Deliberately NOT cached, unlike the history signature. That one is a
 * read capability reused across visits; this authorises a one-time,
 * irreversible write, and it names the exact username being taken — so it is
 * signed once, for that name, at the moment the person asks for it.
 */
export async function signUsernameClaim(
  wallet: string,
  username: string,
  provider: Eip1193Provider,
): Promise<{ timestamp: number; signature: string }> {
  const { ethers } = await import("ethers");
  const { browserProviderFrom } = await import("@/lib/wallet-provider");
  const timestamp = Math.floor(Date.now() / 1000);
  const message = usernameClaimMessage(wallet, username, timestamp);
  const browserProvider = await browserProviderFrom(provider);
  const signer = await browserProvider.getSigner();
  const signature = await signer.signMessage(message);
  return { timestamp, signature };
}
