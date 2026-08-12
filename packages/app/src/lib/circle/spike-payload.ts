// The EIP-712 document the spike signs.
//
// Shaped as a real StableFX quote payload rather than a toy "Mail" example on
// purpose. The question this spike answers is not "can this wallet sign
// something" — it is "can this wallet sign what Circle's FX engine will
// actually hand it, and does ecrecover then resolve to the wallet's own
// address". Those differ: a nested struct array, a bytes32, and a uint256 all
// exercise encoding paths a flat message never touches.
//
// This matters because the failure it is looking for has already happened once
// here with a different provider. lib/sign-typed-data.ts records it: "observed
// with the Privy embedded wallet, where external wallets settled fine and the
// embedded one failed 3015 every time" — Circle rejecting a trade because the
// signature recovered to an address other than the one registered. A managed
// wallet that signs a *different digest* than the one you handed it looks
// identical to a working wallet until settlement fails.
export interface TypedDataDocument {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

// Arc testnet. Signing is a pure local operation — no transaction, no funds,
// nothing broadcast — so the verifying contract need only be well-formed.
const ARC_TESTNET_CHAIN_ID = 5042002;

export function buildSpikePayload(walletAddress: string): TypedDataDocument {
  return {
    domain: {
      name: "Conduit Circle Wallet Spike",
      version: "1",
      chainId: ARC_TESTNET_CHAIN_ID,
      verifyingContract: "0x0000000000000000000000000000000000000001",
    },
    // EIP712Domain is included because Circle's own payloads include it.
    // ethers derives it from `domain` and rejects it being passed explicitly,
    // so the recover step strips it — mirroring signTypedDataWithWallet.
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Leg: [
        { name: "currency", type: "string" },
        { name: "amount", type: "uint256" },
      ],
      Trade: [
        { name: "owner", type: "address" },
        { name: "quoteId", type: "bytes32" },
        { name: "legs", type: "Leg[]" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Trade",
    message: {
      owner: walletAddress,
      // Fixed, not random: a rerun must produce the same digest, so a changed
      // signature means the wallet changed behaviour, not that the input did.
      quoteId: "0x" + "11".repeat(32),
      legs: [
        { currency: "USDC", amount: "5000000" },
        { currency: "EURC", amount: "4470000" },
      ],
      deadline: "1893456000",
    },
  };
}
