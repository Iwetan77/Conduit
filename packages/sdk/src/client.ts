import { ethers } from "ethers";
import { ARC_TESTNET, QUOTE_TTL_SECONDS, DEFAULT_APP_URL } from "./constants.js";
import { DeclarationClient } from "./declaration.js";
import { RouterClient } from "./router.js";
import { ReceiptClient } from "./receipt.js";
import { swapWithBrowserWallet, toHumanAmount } from "./swap.js";
import type {
  Address,
  Bytes32,
  Currency,
  PaymentDeclaration,
  PaymentReceipt,
  Quote,
  ConduitClientConfig,
  PayOptions,
  CreateLinkOptions,
  FulfillOptions,
  GetHistoryOptions,
} from "./types.js";

/// @notice Main entry point for the Conduit SDK.
///
/// Usage:
///   const conduit = new ConduitClient({ signer, kitKey: "TEST_...", network: "arc-testnet" });
///   await conduit.pay({ recipient, amount: 10_000_000n, currency: "USDC" });
///   await conduit.pay({ recipient, amount: 10_000_000n, currency: "EURC", payerToken: "USDC" }); // cross-currency
///   const { paymentUrl } = await conduit.createLink({ amount: 0n, currency: "EURC" });
export class ConduitClient {
  private provider: ethers.JsonRpcProvider;
  private signerProvider: ethers.BrowserProvider | ethers.JsonRpcProvider;
  private signerAddress?: Address;
  private appUrl: string;
  private kitKey: string;

  private declarationClient: DeclarationClient;
  private routerClient: RouterClient;
  private receiptClient: ReceiptClient;

  constructor(config: ConduitClientConfig) {
    const rpc = ARC_TESTNET.rpc;
    this.provider = new ethers.JsonRpcProvider(rpc, {
      chainId: ARC_TESTNET.chainId,
      name: "arc-testnet",
    });

    this.signerProvider = this.provider;
    this.appUrl = config.appUrl ?? DEFAULT_APP_URL;
    this.kitKey = config.kitKey ?? "";

    this.declarationClient = new DeclarationClient(this.provider, config.signer, this.appUrl);
    this.routerClient = new RouterClient(this.provider);
    this.receiptClient = new ReceiptClient(this.provider);
  }

  // ── Static factory for browser (wagmi/viem) ──────────────────────────────

  static fromBrowserProvider(
    provider: ethers.BrowserProvider,
    kitKey: string,
    appUrl?: string
  ): ConduitClient {
    const mockSigner = {
      getAddress: async () => {
        const s = await provider.getSigner();
        return s.getAddress();
      },
      sendTransaction: async (tx: unknown) => {
        const s = await provider.getSigner();
        const txResp = await s.sendTransaction(tx as ethers.TransactionRequest);
        return {
          hash: txResp.hash,
          wait: async () => {
            const receipt = await txResp.wait();
            return { status: receipt?.status ?? 0, blockNumber: receipt?.blockNumber ?? 0 };
          },
        };
      },
    };
    const client = new ConduitClient({ signer: mockSigner, kitKey, ...(appUrl !== undefined ? { appUrl } : {}) });
    client.signerProvider = provider;
    return client;
  }

  // ── Core API ──────────────────────────────────────────────────────────────

  /// @notice Send a payment. Handles both same-currency and cross-currency.
  ///
  ///   Same-currency (USDC→USDC, EURC→EURC):
  ///     Single tx: ConduitRouter.execute()
  ///
  ///   Cross-currency (USDC→EURC or EURC→USDC):
  ///     Tx 1: Circle App Kit kit.swap() → converts in payer's wallet
  ///     Tx 2: ConduitRouter.execute() → forwards to recipient
  ///
  async pay(options: PayOptions): Promise<PaymentReceipt> {
    const signerAddr = await this.getSignerAddress();
    const payerToken = this.currencyToAddress(options.payerToken ?? options.currency);
    const recipientToken = this.currencyToAddress(options.currency);
    const deadline = Math.floor(Date.now() / 1000) + QUOTE_TTL_SECONDS;

    if (payerToken !== recipientToken) {
      // ── Cross-currency: swap first, then transfer ─────────────────────────
      if (!this.kitKey) {
        throw new Error(
          "Cross-currency payments require a Circle Kit Key. " +
          "Get one at https://console.circle.com → Keys → Kit Key, " +
          "then pass it as kitKey in ConduitClient config."
        );
      }

      // Step 1: Swap payerToken → recipientToken in payer's wallet
      const humanAmount = toHumanAmount(options.amount);
      const swapResult = await swapWithBrowserWallet(
        this.getEip1193Provider(),
        options.payerToken ?? options.currency,
        options.currency,
        humanAmount,
        this.kitKey
      );

      // Step 2: Transfer the received recipientToken to recipient
      // amountOutRaw is in base units (6 decimals); fall back to requested amount
      // if LI.FI lookup failed and amountOut is unavailable.
      const receivedAmount = swapResult.amountOutRaw
        ? BigInt(swapResult.amountOutRaw)
        : options.amount;

      const instruction = {
        payer: signerAddr,
        recipient: options.recipient,
        payerToken: recipientToken, // now same as recipient (post-swap)
        recipientToken,
        amount: receivedAmount,
        deadline,
        declarationId: "0x0000000000000000000000000000000000000000000000000000000000000000" as Bytes32,
      };

      return this.routerClient.execute(instruction, this.signerProvider);
    }

    // ── Same-currency: single tx ──────────────────────────────────────────
    const instruction = {
      payer: signerAddr,
      recipient: options.recipient,
      payerToken,
      recipientToken,
      amount: options.amount,
      deadline,
      declarationId: "0x0000000000000000000000000000000000000000000000000000000000000000" as Bytes32,
    };

    return this.routerClient.execute(instruction, this.signerProvider);
  }

  /// @notice Create a payment declaration and get a shareable URL + declarationId.
  async createLink(
    options: CreateLinkOptions
  ): Promise<{ declarationId: Bytes32; paymentUrl: string; txHash: string }> {
    return this.declarationClient.register(options, this.signerProvider);
  }

  /// @notice Parse a declaration from a Conduit payment URL.
  async parse(url: string): Promise<PaymentDeclaration> {
    return this.declarationClient.parseUrl(url);
  }

  /// @notice Fulfill a parsed payment declaration.
  async fulfill(
    declaration: PaymentDeclaration,
    options: FulfillOptions = {}
  ): Promise<PaymentReceipt> {
    const signerAddr = await this.getSignerAddress();
    const payerCurrency = options.payerToken ?? declaration.currency;
    const payerToken = this.currencyToAddress(payerCurrency);
    const deadline = Math.floor(Date.now() / 1000) + QUOTE_TTL_SECONDS;

    if (payerToken !== declaration.recipientToken) {
      // Cross-currency fulfill: swap then transfer
      if (!this.kitKey) {
        throw new Error(
          "Cross-currency fulfillment requires a Circle Kit Key. " +
          "Get one at https://console.circle.com → Keys → Kit Key."
        );
      }

      const humanAmount = toHumanAmount(declaration.amount);

      const swapResult = await swapWithBrowserWallet(
        this.getEip1193Provider(),
        payerCurrency,
        declaration.currency,
        humanAmount,
        this.kitKey
      );

      const receivedAmount = swapResult.amountOutRaw
        ? BigInt(swapResult.amountOutRaw)
        : declaration.amount;

      const instruction = {
        payer: signerAddr,
        recipient: declaration.recipient,
        payerToken: declaration.recipientToken,
        recipientToken: declaration.recipientToken,
        amount: receivedAmount,
        deadline,
        declarationId: declaration.declarationId,
      };

      return this.routerClient.execute(instruction, this.signerProvider);
    }

    // Same-currency fulfill
    const instruction = {
      payer: signerAddr,
      recipient: declaration.recipient,
      payerToken,
      recipientToken: declaration.recipientToken,
      amount: declaration.amount,
      deadline,
      declarationId: declaration.declarationId,
    };

    return this.routerClient.execute(instruction, this.signerProvider);
  }

  /// @notice Deactivate a declaration (only callable by the creator).
  async deactivateLink(declarationId: Bytes32): Promise<string> {
    return this.declarationClient.deactivate(declarationId, this.signerProvider);
  }

  /// @notice Quote a payment.
  ///   - Same-currency: returns exact amount (includes protocol fee).
  ///   - Cross-currency: returns 0 (live rate from kit.swap() at execution time).
  async quote(options: {
    payerToken: Currency;
    recipientToken: Currency;
    amount: bigint;
  }): Promise<Quote> {
    const signerAddr = await this.getSignerAddress();
    const payerTokenAddr = this.currencyToAddress(options.payerToken);
    const recipientTokenAddr = this.currencyToAddress(options.recipientToken);
    const deadline = Math.floor(Date.now() / 1000) + QUOTE_TTL_SECONDS;
    const isSame = payerTokenAddr === recipientTokenAddr;

    const instruction = {
      payer: signerAddr,
      recipient: signerAddr,
      payerToken: payerTokenAddr,
      recipientToken: recipientTokenAddr,
      amount: options.amount,
      deadline,
      declarationId: "0x0000000000000000000000000000000000000000000000000000000000000000" as Bytes32,
    };

    const payerAmount = isSame
      ? await this.routerClient.quote(instruction)
      : 0n; // cross-currency rate determined at swap time by Circle App Kit

    return {
      payerToken: payerTokenAddr,
      recipientToken: recipientTokenAddr,
      payerAmount: payerAmount > 0n ? payerAmount : options.amount,
      recipientAmount: options.amount,
      rate: 1,
      expiresAt: deadline,
    };
  }

  // ── Receipt & History ─────────────────────────────────────────────────────

  async getReceipt(receiptId: Bytes32): Promise<PaymentReceipt | null> {
    return this.receiptClient.getReceipt(receiptId);
  }

  async getHistory(wallet: Address, options?: GetHistoryOptions): Promise<PaymentReceipt[]> {
    return this.receiptClient.getHistory(wallet, options);
  }

  async resolveDeclaration(declarationId: Bytes32): Promise<PaymentDeclaration> {
    return this.declarationClient.resolve(declarationId);
  }

  async getDeclarations(wallet: Address): Promise<PaymentDeclaration[]> {
    return this.declarationClient.getDeclarationsForRecipient(wallet);
  }

  async getBalance(wallet: Address, currency: Currency): Promise<bigint> {
    const { ethers: _ethers } = await import("ethers");
    const { ERC20_ABI } = await import("./constants.js");
    const tokenAddress = this.currencyToAddress(currency);
    const token = new _ethers.Contract(tokenAddress, ERC20_ABI, this.provider) as unknown as {
      balanceOf(addr: string): Promise<bigint>;
    };
    return BigInt(await token.balanceOf(wallet));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async getSignerAddress(): Promise<Address> {
    if (this.signerAddress) return this.signerAddress;
    const signer = await (this.signerProvider as ethers.BrowserProvider).getSigner?.();
    if (!signer) throw new Error("No signer available. Connect a wallet.");
    this.signerAddress = (await signer.getAddress()) as Address;
    return this.signerAddress;
  }

  // Wrap ethers BrowserProvider as an EIP-1193 object for Circle App Kit
  private getEip1193Provider(): unknown {
    const sp = this.signerProvider as ethers.BrowserProvider;
    return {
      request: ({ method, params }: { method: string; params?: unknown[] }) =>
        sp.send(method, (params ?? []) as unknown[]),
    };
  }

  currencyToAddress(currency: Currency): Address {
    return currency === "USDC" ? ARC_TESTNET.tokens.USDC : ARC_TESTNET.tokens.EURC;
  }

  formatAmount(amount: bigint, currency: Currency): string {
    const divisor = 10n ** 6n;
    const whole = amount / divisor;
    const fraction = amount % divisor;
    const fractionStr = fraction.toString().padStart(6, "0").replace(/0+$/, "");
    return fractionStr ? `${whole}.${fractionStr} ${currency}` : `${whole} ${currency}`;
  }

  parseAmount(humanAmount: string, _currency: Currency): bigint {
    const [whole = "0", fraction = "0"] = humanAmount.replace(/[^0-9.]/g, "").split(".");
    const paddedFraction = fraction.slice(0, 6).padEnd(6, "0");
    return BigInt(whole) * 10n ** 6n + BigInt(paddedFraction);
  }
}
