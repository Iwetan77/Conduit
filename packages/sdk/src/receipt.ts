import { ethers } from "ethers";
import { ARC_TESTNET, ROUTER_ABI } from "./constants.js";
import type { Address, Bytes32, PaymentReceipt, GetHistoryOptions } from "./types.js";

export class ReceiptClient {
  private contract: ethers.Contract;
  private provider: ethers.Provider;

  constructor(provider: ethers.Provider) {
    this.provider = provider;
    this.contract = new ethers.Contract(
      ARC_TESTNET.contracts.conduitRouter,
      ROUTER_ABI,
      provider
    );
  }

  // ── Get receipt by ID ─────────────────────────────────────────────────────

  async getReceipt(receiptId: Bytes32): Promise<PaymentReceipt | null> {
    const iface = new ethers.Interface(ROUTER_ABI);
    const filter = this.contract.filters.PaymentSettled(receiptId);

    const events = await this.contract.queryFilter(filter, -10000); // last 10k blocks
    if (events.length === 0) return null;

    const event = events[0];
    if (!event) return null;
    const parsed = iface.parseLog(event);
    if (!parsed) return null;

    return this.eventToReceipt(parsed, event.transactionHash);
  }

  // ── Get history for a wallet ──────────────────────────────────────────────

  async getHistory(wallet: Address, options: GetHistoryOptions = {}): Promise<PaymentReceipt[]> {
    const { limit = 20, offset = 0 } = options;
    const iface = new ethers.Interface(ROUTER_ABI);

    // Arc testnet RPC caps eth_getLogs at 10,000 blocks per request.
    // Fetch the last 40,000 blocks in 4 chunks of 10,000 and merge results.
    const CHUNK = 9_000; // stay under the 10k limit
    const CHUNKS = 4;
    const latest = await this.provider.getBlockNumber();
    const fromBlock = Math.max(0, latest - CHUNK * CHUNKS);

    const ranges: [number, number][] = [];
    for (let start = fromBlock; start < latest; start += CHUNK) {
      ranges.push([start, Math.min(start + CHUNK - 1, latest)]);
    }

    const fetchChunks = async (topics: (string | null)[]) => {
      const results = await Promise.allSettled(
        ranges.map(([from, to]) =>
          this.provider.getLogs({
            address: ARC_TESTNET.contracts.conduitRouter,
            topics,
            fromBlock: from,
            toBlock: to,
          })
        )
      );
      return results
        .filter((r): r is PromiseFulfilledResult<ethers.Log[]> => r.status === "fulfilled")
        .flatMap((r) => r.value);
    };

    const eventTopic = iface.getEvent("PaymentSettled")!.topicHash;

    // payer is topic[2], recipient is topic[3] (receiptId=topic[1])
    const [payerLogs, recipientLogs] = await Promise.all([
      fetchChunks([eventTopic, null, ethers.zeroPadValue(wallet, 32), null]),
      fetchChunks([eventTopic, null, null, ethers.zeroPadValue(wallet, 32)]),
    ]);

    const allEvents = [...payerLogs, ...recipientLogs];

    // Deduplicate and sort by block desc
    const seen = new Set<string>();
    const unique = allEvents
      .filter((e) => {
        const key = e.transactionHash;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.blockNumber - a.blockNumber)
      .slice(offset, offset + limit);

    const receipts: PaymentReceipt[] = [];
    for (const event of unique) {
      const parsed = iface.parseLog(event);
      if (parsed) {
        receipts.push(this.eventToReceipt(parsed, event.transactionHash));
      }
    }

    return receipts;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private eventToReceipt(
    parsed: ethers.LogDescription,
    txHash: string
  ): PaymentReceipt {
    return {
      receiptId: parsed.args["receiptId"] as Bytes32,
      payer: parsed.args["payer"] as Address,
      recipient: parsed.args["recipient"] as Address,
      payerToken: parsed.args["payerToken"] as Address,
      recipientToken: parsed.args["recipientToken"] as Address,
      payerAmount: BigInt(parsed.args["payerAmount"]),
      recipientAmount: BigInt(parsed.args["recipientAmount"]),
      declarationId: parsed.args["declarationId"] as Bytes32,
      settledAt: Number(parsed.args["settledAt"]),
      txHash: txHash as `0x${string}`,
      explorerUrl: `${ARC_TESTNET.explorer}/tx/${txHash}`,
    };
  }
}
