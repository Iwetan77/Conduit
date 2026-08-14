// Which identity provider is live, in one place.
//
// This was read in three files with two different shapes: providers.tsx applied
// the default (`?? "privy"`), while dashboard/layout.tsx and WalletConnect.tsx
// asked `=== "circle"`, which is false when the variable is unset. That was
// harmless only while the default was "privy" and both answers agreed. Flipping
// the default without collapsing them to one constant would have put the
// provider tree on Circle while the dashboard and the sign-in button stayed on
// the Privy branch -- the same class of seam bug as every other one in this
// migration: one side of a contract changed, the other never re-read.
//
// Next inlines `process.env.NEXT_PUBLIC_*` only where it appears literally, so
// the read has to be a member expression like this. Exporting the RESULT is
// fine; exporting a function that reads it later is not.
export const AUTH_PROVIDER = process.env.NEXT_PUBLIC_AUTH_PROVIDER ?? "circle";

/** True when Google sign-in is served by Circle Wallets rather than Privy. */
export const CIRCLE_AUTH = AUTH_PROVIDER === "circle";
