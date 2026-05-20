import { ethers } from "ethers";
import { ARC_TESTNET, QUOTE_TTL_SECONDS, DEFAULT_APP_URL } from "./constants.js";
import { DeclarationClient } from "./declaration.js";
import { RouterClient } from "./router.js";
import { ReceiptClient } from "./receipt.js";
import { swap, swapWithBrowserWallet, toHumanAmount } from "./swap.js";
import { discover as _discover } from "./discovery.js";
import type { DiscoveryResult } from "./discovery.js";
import type {
  Address,
  Bytes32,
  Currency,
  PaymentDeclaration,
  PaymentReceipt,
  Quote,
  ConduitClientConfig,
  AgentConfig,
  PayOptions,
  CreateLinkOptions,
  FulfillOptions,
  GetHistoryOptions,
} from "./types.js";

/// @notice Main entry point for the Conduit SDK.
///
/// Browser usage (wagmi/viem):
///   const conduit = ConduitClient.fromBrowserProvider(window.ethereum, kitKey);
///   await conduit.pay({ recipient, amount: 10_000_000n, currency: "USDC" });
///
/// Server / agent usage:
///   const conduit = new ConduitClient({ privateKey: process.env.PRIVATE_KEY, kitKey: "..." });
///   const result = await conduit.discover("https://service.xyz/api");
///   if (result.found) await conduit.fulfill(result.declaration!);
export class ConduitClient {
  private provider: ethers.JsonRpcProvider;
  private signerProvider: ethers.BrowserProvider | ethers.JsonRpcProvider;
  private signerAddress?: Address;
  private appUrl: string;
  private kitKey: string;
  private privateKey?: string;
  private walletSigner?: ethers.Wallet;
  private agentConfig?: AgentConfig;

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
    this.agentConfig = config.agentConfig;

    // Server-side: build a wallet signer from privateKey
    if (config.privateKey) {
      this.privateKey = config.privateKey;
      this.walletSigner = new ethers.Wallet(config.privateKey, this.provider);
      if (!config.signer) {
        config.signer = this.walletSigner;
      }
    }

    if (!config.signer) {
      throw new Error(
        "ConduitClient requires either signer or privateKey. " +
        "Pass a wallet signer for browser flows, or privateKey for server/agent flows."
      );
    }

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
  ///     Server path: swap() via privateKey → ConduitRouter.execute()
  ///     Browser path: swapWithBrowserWallet() → ConduitRouter.execute()
  ///
  async pay(options: PayOptions): Promise<PaymentReceipt> {
    // Enforce agent spending constraints before any execution
    await this.checkAgentConstraints(options);

    const signerAddr = await this.getSignerAddress();
    const payerToken = this.currencyToAddress(options.payerToken ?? options.currency);
    const recipientToken = this.currencyToAddress(options.currency);
    const deadline = Math.floor(Date.now() / 1000) + QUOTE_TTL_SECONDS;

    if (payerToken !== recipientToken) {
      // ── Cross-currency: swap via ArcSwap Uniswap V2, then transfer ────────
      const humanAmount = toHumanAmount(options.amount);

      // Detect environment: server (Node.js) vs browser
      const isServer = typeof window === "undefined";
      let swapResult;

      if (isServer) {
        // Server/agent path — requires privateKey in config
        if (!this.privateKey) {
          throw new Error(
            "Server-side cross-currency payments require privateKey in ConduitClient config. " +
            "Example: new ConduitClient({ privateKey: process.env.PRIVATE_KEY, kitKey: '...' })"
          );
        }
        swapResult = await swap(
          this.privateKey,
          options.payerToken ?? options.currency,
          options.currency,
          humanAmount,
          this.kitKey
        );
      } else {
        // Browser path — uses EIP-1193 provider
        swapResult = await swapWithBrowserWallet(
          this.getEip1193Provider(),
          options.payerToken ?? options.currency,
          options.currency,
          humanAmount,
          this.kitKey
        );
      }

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

      return this.routerClient.execute(instruction, this.getSignerProvider());
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

    return this.routerClient.execute(instruction, this.getSignerProvider());
  }

  /// @notice Create a payment declaration and get a shareable URL + declarationId.
  async createLink(
    options: CreateLinkOptions
  ): Promise<{ declarationId: Bytes32; paymentUrl: string; txHash: string }> {
    return this.declarationClient.register(options, this.getSignerProvider());
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
      // Cross-currency fulfill: swap via ArcSwap V2, then transfer
      const humanAmount = toHumanAmount(declaration.amount);

      // Detect environment: server (Node.js) vs browser
      const isServer = typeof window === "undefined";
      let swapResult;

      if (isServer) {
        if (!this.privateKey) {
          throw new Error(
            "Server-side cross-currency fulfillment requires privateKey in ConduitClient config."
          );
        }
        swapResult = await swap(
          this.privateKey,
          payerCurrency,
          declaration.currency,
          humanAmount,
          this.kitKey
        );
      } else {
        swapResult = await swapWithBrowserWallet(
          this.getEip1193Provider(),
          payerCurrency,
          declaration.currency,
          humanAmount,
          this.kitKey
        );
      }

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

      return this.routerClient.execute(instruction, this.getSignerProvider());
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

    return this.routerClient.execute(instruction, this.getSignerProvider());
  }

  /// @notice Discover a Conduit payment declaration from a service endpoint.
  ///
  /// Checks for a Conduit-Payment HTTP header or /.well-known/conduit file.
  /// Returns the declaration if found, or { found: false } if not.
  ///
  /// Use with fulfill() for fully autonomous agent payment flows:
  ///   const result = await conduit.discover("https://service.xyz/api")
  ///   if (result.found) await conduit.fulfill(result.declaration!)
  async discover(url: string): Promise<DiscoveryResult> {
    return _discover(url, this.declarationClient);
  }

  /// @notice Deactivate a declaration (only callable by the creator).
  async deactivateLink(declarationId: Bytes32): Promise<string> {
    return this.declarationClient.deactivate(declarationId, this.getSignerProvider());
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

  /// @notice Enforce agent spending constraints before any payment execution.
  private async checkAgentConstraints(options: PayOptions): Promise<void> {
    if (!this.agentConfig) return;

    const { maxPerTransactionUSDC, allowedTokens, allowedRecipients } = this.agentConfig;

    if (
      maxPerTransactionUSDC &&
      maxPerTransactionUSDC > 0n &&
      options.amount > maxPerTransactionUSDC
    ) {
      throw new Error(
        `Payment of ${options.amount} exceeds agent maxPerTransactionUSDC ` +
        `limit of ${maxPerTransactionUSDC}`
      );
    }

    if (allowedTokens && allowedTokens.length > 0) {
      if (!allowedTokens.includes(options.currency)) {
        throw new Error(
          `Token ${options.currency} is not in agent allowedTokens: ` +
          `${allowedTokens.join(", ")}`
        );
      }
    }

    if (allowedRecipients && allowedRecipients.length > 0) {
      const recipientLower = options.recipient.toLowerCase();
      const allowed = allowedRecipients.map((r) => r.toLowerCase());
      if (!allowed.includes(recipientLower)) {
        throw new Error(
          `Recipient ${options.recipient} is not in agent allowedRecipients`
        );
      }
    }
  }

  private async getSignerAddress(): Promise<Address> {
    if (this.signerAddress) return this.signerAddress;

    // Fast path for server-side wallet
    if (this.walletSigner) {
      this.signerAddress = (await this.walletSigner.getAddress()) as Address;
      return this.signerAddress;
    }

    const signer = await (this.signerProvider as ethers.BrowserProvider).getSigner?.();
    if (!signer) throw new Error("No signer available. Connect a wallet.");
    this.signerAddress = (await signer.getAddress()) as Address;
    return this.signerAddress;
  }

  /// @notice Returns a signerProvider-compatible object for sub-clients.
  /// For server-side wallet flows, wraps the wallet into a getSigner() interface.
  private getSignerProvider(): ethers.BrowserProvider | ethers.JsonRpcProvider {
    if (this.walletSigner) {
      const wallet = this.walletSigner;
      // Wrap wallet as a minimal provider-like object that returns the wallet as signer
      return {
        getSigner: async (_addressOrIndex?: string | number) =>
          wallet as unknown as ethers.JsonRpcSigner,
      } as unknown as ethers.JsonRpcProvider;
    }
    return this.signerProvider as ethers.BrowserProvider | ethers.JsonRpcProvider;
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
