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

    // Arc testnet RPC caps eth_getLogs at 10,000 blocks per request and
    // rate-limits bursts (-32011 / plain 429 without CORS headers, which a
    // browser surfaces as an opaque "Failed to fetch"). That is why this does
    // not fan out all eight calls at once.
    //
    // It used to run them STRICTLY sequentially, which turned out to be the
    // reason /history and /links "took forever". Measured against the deployed
    // RPC: a single 9,000-block getLogs is about 0.6s and is the same at every
    // depth in the window — but roughly one call in eight HANGS, once observed
    // at 45 seconds. Sequentially, that one stall is the page's load time. Eight
    // good calls at 0.6s should be five seconds; the median page was not.
    //
    // So: a small amount of concurrency, and a deadline per call. Concurrency 3
    // is nowhere near a burst and keeps a stalled range from blocking the ones
    // behind it; the deadline is what actually caps the damage, since a hang is
    // not an error and never returns on its own.
    const CHUNK = 9_000; // stay under the 10k limit
    const CHUNKS = 4;
    const CONCURRENCY = 3;
    // Well above the ~0.6s a healthy call takes, and far below the stall. A
    // range that exceeds this is abandoned rather than waited on: losing part
    // of the window is a smaller harm than a page that never loads.
    const CALL_TIMEOUT_MS = 8_000;

    const withTimeout = <T>(call: () => Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("arc rpc call timed out")),
          CALL_TIMEOUT_MS
        );
        call().then(
          (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          (e) => {
            clearTimeout(timer);
            reject(e);
          }
        );
      });

    // Retries stay, because a 429 under load is worth backing off from. Two
    // attempts rather than three: with a deadline on each, three attempts is
    // 24 seconds spent on one range that has already failed twice.
    const withRetry = async <T>(call: () => Promise<T>): Promise<T> => {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await withTimeout(call);
        } catch (err) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1) ** 2));
        }
      }
      throw lastErr;
    };

    // Runs `jobs` at most `CONCURRENCY` at a time, in order, never rejecting:
    // a failed range loses part of the window rather than the whole page.
    const runPooled = async (jobs: (() => Promise<ethers.Log[]>)[]) => {
      const out: ethers.Log[] = [];
      let next = 0;
      const workers = Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
        for (;;) {
          const mine = next++;
          if (mine >= jobs.length) return;
          try {
            out.push(...(await jobs[mine]!()));
          } catch {
            // Best-effort by design — see the deadline note above.
          }
        }
      });
      await Promise.all(workers);
      return out;
    };

    const latest = await withRetry(() => this.provider.getBlockNumber());
    const fromBlock = Math.max(0, latest - CHUNK * CHUNKS);

    const ranges: [number, number][] = [];
    for (let start = fromBlock; start < latest; start += CHUNK) {
      ranges.push([start, Math.min(start + CHUNK - 1, latest)]);
    }

    const eventTopic = iface.getEvent("PaymentSettled")!.topicHash;

    // payer is topic[2], recipient is topic[3] (receiptId=topic[1])
    const topicSets: (string | null)[][] = [
      [eventTopic, null, ethers.zeroPadValue(wallet, 32), null],
      [eventTopic, null, null, ethers.zeroPadValue(wallet, 32)],
    ];

    // Both topic sets (paid-by-me, paid-to-me) across every range, as one flat
    // list of jobs. They are independent reads, so there is no reason for the
    // "paid to me" half to wait behind the "paid by me" half.
    const jobs = topicSets.flatMap((topics) =>
      ranges.map(
        ([from, to]) => () =>
          withRetry(() =>
            this.provider.getLogs({
              address: ARC_TESTNET.contracts.conduitRouter,
              topics,
              fromBlock: from,
              toBlock: to,
            })
          )
      )
    );

    const allEvents = await runPooled(jobs);

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
