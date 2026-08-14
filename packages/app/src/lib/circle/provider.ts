"use client";

// An EIP-1193 provider backed by a Circle user-controlled wallet.
//
// This is the whole point of Phase 2. Every write path in the app already goes
// through getWalletProvider(connector) and then ethers.BrowserProvider, so if
// a Circle wallet can present itself as an EIP-1193 provider, those eight call
// sites do not change at all. The alternative — teaching each one about
// challenges and user tokens — would spread Circle's API across the codebase
// and make backing out of the migration impossible.
//
// The impedance mismatch is transactions. An EIP-1193 caller expects
// eth_sendTransaction to return a transaction HASH, synchronously enough to
// hand to provider.waitForTransaction(). Circle instead:
//
//   1. prepares a challenge (server, API key)
//   2. has the USER authorise it in Circle's own UI (browser, PIN)
//   3. broadcasts it, and gives back an id of Circle's own
//   4. produces a tx hash some seconds later
//
// So eth_sendTransaction here is a long operation that polls until the hash
// exists. That is a real wait on a real network, and callers already await it.
//
// Reads are not Circle's business. Anything that isn't a wallet operation is
// forwarded to the ACTIVE chain's JSON-RPC unchanged, which keeps eth_call,
// eth_getLogs, gas estimation and every other read on exactly the path they
// already use.
//
// Multi-chain, because Circle provisions a wallet per blockchain. Paying an
// invoice from USDC held on Base means depositing into Gateway from a Base
// wallet, so wallet_switchEthereumChain swaps which wallet signs rather than
// refusing. Refusing is what made cross-chain pay impossible for a Google
// sign-in: the wallet was pinned to Arc and there was nothing to deposit from.

import { ARC_RPC_URL, arcTestnet } from "@/lib/chain";
import { chainByCircleId, chainByEvmId, type CircleChain } from "@/lib/circle/chains";

/** Circle's challenge execution, injected so this file never imports the SDK. */
export type ExecuteChallenge = (challengeId: string) => Promise<unknown>;

export interface CircleProviderConfig {
  /** The wallet's on-chain address. */
  address: string;
  /** Circle's id for the wallet, which its transaction APIs key on. */
  walletId: string;
  /**
   * Every wallet this user holds, one per blockchain.
   *
   * Cross-chain pay depends on this. Circle provisions a wallet per chain, so
   * depositing into Gateway from Base means signing with the Base wallet —
   * the Arc wallet cannot do it. wallet_switchEthereumChain swaps which of
   * these is active, which is how an ordinary EIP-1193 consumer (Circle's own
   * UBK adapter, here) gets a wallet that is "on" the source chain.
   */
  wallets?: { id: string; address: string; blockchain: string }[];
  /** Circle's per-user session token. */
  userToken: string;
  /** Conduit API base — challenges are minted server-side. */
  apiBase: string;
  /** Runs a challenge in Circle's UI. */
  execute: ExecuteChallenge;
  /** Called with progress while a send is in flight. Optional. */
  onProgress?: (stage: string) => void;
}

/** How long to wait for Circle to turn a challenge into a broadcast tx hash. */
const HASH_TIMEOUT_MS = 120_000;
const HASH_POLL_MS = 2_000;

/** EIP-1193 error shape. Callers (and wagmi) switch on `code`. */
class ProviderRpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = "ProviderRpcError";
  }
}

interface TxRequest {
  from?: string;
  to?: string;
  data?: string;
  value?: string;
  gas?: string;
}

export function createCircleProvider(config: CircleProviderConfig) {
  const { userToken, apiBase, execute } = config;
  const progress = (s: string) => config.onProgress?.(s);

  // The wallet currently being signed with, and the chain it lives on.
  // Defaults to the one passed explicitly, which is Arc in every path except
  // a cross-chain deposit.
  const wallets = config.wallets?.length
    ? config.wallets
    : [{ id: config.walletId, address: config.address, blockchain: "ARC-TESTNET" }];

  let active: { id: string; address: string; blockchain: string } =
    wallets.find((w) => w.id === config.walletId) ?? wallets[0];
  let activeChain: CircleChain =
    chainByCircleId(active.blockchain) ??
    ({ circle: "ARC-TESTNET", id: arcTestnet.id, rpc: ARC_RPC_URL, label: arcTestnet.name } as CircleChain);

  const address = () => active.address;
  const walletId = () => active.id;

  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "X-Circle-User-Token": userToken,
      },
    }).catch(() => {
      throw new ProviderRpcError(
        -32603,
        `could not reach ${apiBase}${path} — the API is down, or CORS refused the request`
      );
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const e = json?.error as { message?: string; param?: string } | undefined;
      throw new ProviderRpcError(
        -32603,
        [e?.message ?? `HTTP ${res.status}`, e?.param].filter(Boolean).join(" — ")
      );
    }
    return json;
  };

  /**
   * Forward a read to the ACTIVE chain. Circle has no opinion about these.
   *
   * Not pinned to Arc: while the wallet is switched to a source chain for a
   * Gateway deposit, every balance and receipt read has to hit that chain or
   * the caller is told it holds nothing.
   */
  const rpc = async (method: string, params: unknown[]) => {
    const res = await fetch(activeChain.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    });
    const json = await res.json();
    if (json.error) {
      throw new ProviderRpcError(json.error.code ?? -32603, json.error.message ?? "RPC error");
    }
    return json.result;
  };

  /**
   * Wait for Circle to produce a tx hash.
   *
   * Terminal failure states are checked explicitly. Without that, a FAILED or
   * DENIED transaction — which will never have a hash — would spin here until
   * the timeout and then be reported as "timed out", hiding the fact that
   * Circle had already refused it and said why.
   */
  const waitForHash = async (
    fetchTx: () => Promise<{
      found?: boolean;
      state?: string;
      tx_hash?: string;
      failed?: boolean;
      error_reason?: string;
    }>,
    describe: string
  ): Promise<string> => {
    const deadline = Date.now() + HASH_TIMEOUT_MS;
    for (;;) {
      const tx = await fetchTx();
      if (tx.tx_hash) return tx.tx_hash;
      if (tx.failed) {
        throw new ProviderRpcError(
          -32000,
          `Circle ${String(tx.state).toLowerCase()} the transaction${
            tx.error_reason ? `: ${tx.error_reason}` : ""
          }`
        );
      }
      if (Date.now() > deadline) {
        // Name it: the transaction may still land, and without this there is
        // no way to find out which one it was.
        throw new ProviderRpcError(
          -32603,
          `Circle did not broadcast within ${HASH_TIMEOUT_MS / 1000}s. ` +
            `Last state ${tx.state ?? (tx.found === false ? "not yet created" : "unknown")}. ` +
            `${describe} — it may still complete.`
        );
      }
      progress(
        `waiting for Circle to broadcast (${tx.state ?? "creating"})…`
      );
      await new Promise((r) => setTimeout(r, HASH_POLL_MS));
    }
  };

  interface CircleTx {
    id: string;
    state?: string;
    tx_hash?: string;
    failed?: boolean;
    error_reason?: string;
    contract_address?: string;
  }

  const listTransactions = async (): Promise<CircleTx[]> => {
    const res = await api(
      `/v1/auth/circle/transactions?wallet_id=${encodeURIComponent(walletId())}`
    );
    return (res.data ?? []) as CircleTx[];
  };

  const sendTransaction = async (tx: TxRequest): Promise<string> => {
    if (!tx.to) {
      // Contract creation has no `to`. Circle's contract-execution endpoint
      // cannot express it, and silently doing something else would be worse
      // than saying so.
      throw new ProviderRpcError(-32601, "Circle wallets cannot deploy contracts");
    }
    if (tx.from && tx.from.toLowerCase() !== address().toLowerCase()) {
      // Signing as someone else is the bug class that made the Privy embedded
      // wallet unusable. Refuse rather than quietly sign from the wrong address.
      throw new ProviderRpcError(
        -32602,
        `this wallet is ${address()}, but the transaction asks to send from ${tx.from}`
      );
    }

    // Snapshot the wallet's transactions BEFORE sending.
    //
    // This is the only reliable way back to the transaction. Circle gives the
    // browser no transaction id at any point — the create call returns a
    // challengeId, and a completed challenge reports the challenge's own type
    // and status. Tagging with refId was the obvious fix and does not work:
    // Circle accepts refId and never returns it, verified against the live API.
    // So the new id that appears after the send is the send. Snapshotting
    // first is what makes that true even with two sends in flight, which
    // "take the most recent" would get wrong.
    progress("preparing…");
    const before = new Set<string>(
      ((await listTransactions()) ?? []).map((t) => t.id)
    );

    const { challenge_id } = await api("/v1/auth/circle/contract_execution", {
      method: "POST",
      body: JSON.stringify({
        wallet_id: walletId(),
        to: tx.to,
        data: tx.data ?? "0x",
        // `value` is hex wei on the wire; Circle wants a decimal string in
        // whole native units. Omitted entirely when zero, which is every
        // ERC-20 call, so the common path never touches this conversion.
        amount: tx.value && BigInt(tx.value) > 0n ? weiToWholeUnits(tx.value) : "",
      }),
    });

    progress("waiting for you to approve in Circle…");
    const result = (await execute(challenge_id)) as
      | { data?: { txHash?: string; id?: string } }
      | undefined;

    // Circle sometimes returns the hash straight from the challenge. Take it
    // when offered rather than polling for something already in hand.
    const immediate = result?.data?.txHash;
    if (immediate) return immediate;

    const circleTxId = result?.data?.id;
    if (circleTxId) {
      return waitForHash(
        () => api(`/v1/auth/circle/transactions/${circleTxId}`),
        `Circle transaction id ${circleTxId}`
      );
    }

    // The normal path: find the transaction that was not there before.
    progress("finding the transaction…");
    return waitForHash(async () => {
      const list = (await listTransactions()) ?? [];
      const fresh = list.filter((t) => !before.has(t.id));
      // Confirm it is ours and not something else the wallet did in the
      // meantime. Contract address is the strongest signal available — the
      // list carries no calldata to compare.
      const mine =
        fresh.find(
          (t) => t.contract_address?.toLowerCase() === tx.to!.toLowerCase()
        ) ?? fresh[0];
      return mine ?? { found: false };
    }, `wallet ${walletId}`);
  };

  const signTypedData = async (params: unknown[]): Promise<string> => {
    // eth_signTypedData_v4 params are [address, jsonString].
    const [who, payload] = params as [string, string | object];
    if (who && who.toLowerCase() !== address().toLowerCase()) {
      throw new ProviderRpcError(-32602, `this wallet is ${address()}, not ${who}`);
    }
    progress("waiting for you to approve the signature…");
    const { challenge_id } = await api("/v1/auth/circle/sign_typed_data", {
      method: "POST",
      body: JSON.stringify({
        wallet_id: walletId(),
        // Pass the document through untouched. Re-serialising it would reorder
        // keys and change the hash that gets signed.
        data: typeof payload === "string" ? JSON.parse(payload) : payload,
      }),
    });
    const result = (await execute(challenge_id)) as { data?: { signature?: string } } | undefined;
    const sig = result?.data?.signature;
    if (!sig) throw new ProviderRpcError(-32603, "Circle returned no signature");
    return sig;
  };

  const personalSign = async (params: unknown[]): Promise<string> => {
    // personal_sign params are [message, address].
    const [message, who] = params as [string, string];
    if (who && who.toLowerCase() !== address().toLowerCase()) {
      throw new ProviderRpcError(-32602, `this wallet is ${address()}, not ${who}`);
    }
    progress("waiting for you to approve the signature…");
    const { challenge_id } = await api("/v1/auth/circle/sign_message", {
      method: "POST",
      body: JSON.stringify({
        wallet_id: walletId(),
        message,
        // A 0x-prefixed message is bytes, not the characters "0x…". Getting
        // this wrong signs a different message and the signature verifies
        // against nothing.
        encoded_by_hex: typeof message === "string" && message.startsWith("0x"),
      }),
    });
    const result = (await execute(challenge_id)) as { data?: { signature?: string } } | undefined;
    const sig = result?.data?.signature;
    if (!sig) throw new ProviderRpcError(-32603, "Circle returned no signature");
    return sig;
  };

  const request = async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
    switch (method) {
      case "eth_accounts":
      case "eth_requestAccounts":
        return [address()];
      case "eth_chainId":
        return `0x${arcTestnet.id.toString(16)}`;
      case "net_version":
        return String(arcTestnet.id);
      case "eth_sendTransaction":
        return sendTransaction((params[0] ?? {}) as TxRequest);
      case "eth_signTypedData_v4":
      case "eth_signTypedData":
        return signTypedData(params);
      case "personal_sign":
        return personalSign(params);
      case "eth_sign":
        // Signs arbitrary bytes with no context — a real phishing primitive
        // and deprecated everywhere. personal_sign covers the honest uses.
        throw new ProviderRpcError(-32601, "eth_sign is not supported; use personal_sign");
      case "wallet_switchEthereumChain":
        // A real chain switch, by swapping which wallet signs.
        //
        // Circle provisions a wallet per blockchain, so "being on Base" means
        // using the Base wallet. Circle's own UBK adapter calls this before a
        // Gateway deposit, and refusing it is what made cross-chain pay
        // impossible for a Google sign-in: the wallet was pinned to Arc, so
        // there was nothing to deposit from.
        {
          const target = (params[0] as { chainId?: string })?.chainId;
          const wanted = target ? parseInt(target, 16) : NaN;
          if (!Number.isFinite(wanted)) {
            throw new ProviderRpcError(-32602, "wallet_switchEthereumChain needs a chainId");
          }
          if (wanted === activeChain.id) return null;

          const chain = chainByEvmId(wanted);
          const wallet = chain && wallets.find((w) => w.blockchain === chain.circle);
          if (!chain || !wallet) {
            // 4902 is the code every wallet library reads as "this chain is
            // not available here", which is exactly true: Circle either does
            // not support it, or this user has no wallet provisioned on it.
            throw new ProviderRpcError(
              4902,
              `this Circle wallet does not exist on chain ${wanted}. ` +
                `Available: ${wallets.map((w) => w.blockchain).join(", ")}`
            );
          }
          active = wallet;
          activeChain = chain;
          progress(`switched to ${chain.label}`);
          return null;
        }
      default:
        // Reads and everything else: Arc answers these, not Circle.
        return rpc(method, params);
    }
  };

  // Event methods are part of EIP-1193 and libraries call them unconditionally.
  // There are no accountsChanged/chainChanged events to emit — the wallet is
  // fixed to one address on one chain for the life of the session — but the
  // methods must exist or ethers throws on subscribe.
  const noop = () => provider;
  const provider = {
    request,
    on: noop,
    removeListener: noop,
    isCircle: true as const,
  };
  return provider;
}

/**
 * Hex wei → decimal whole units, exactly.
 *
 * Deliberately not via Number: 1e18 wei does not survive a float, and this is
 * money. String division keeps every digit.
 */
function weiToWholeUnits(hexWei: string): string {
  const wei = BigInt(hexWei);
  const base = 10n ** BigInt(arcTestnet.nativeCurrency.decimals);
  const whole = wei / base;
  const frac = (wei % base).toString().padStart(arcTestnet.nativeCurrency.decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
