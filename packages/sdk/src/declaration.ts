import { ethers } from "ethers";
import { ARC_TESTNET, REGISTRY_ABI, DEFAULT_APP_URL } from "./constants.js";
import type {
  Address,
  Bytes32,
  Currency,
  PaymentDeclaration,
  CreateLinkOptions,
  SignerLike,
} from "./types.js";

export class DeclarationClient {
  private contract: ethers.Contract;
  private signer: SignerLike;
  private appUrl: string;

  constructor(provider: ethers.Provider, signer: SignerLike, appUrl = DEFAULT_APP_URL) {
    this.signer = signer;
    this.appUrl = appUrl;

    const registryAddress = ARC_TESTNET.contracts.declarationRegistry;
    if (!registryAddress) {
      throw new Error(
        "DeclarationRegistry address not set. Deploy contracts first and set NEXT_PUBLIC_DECLARATION_REGISTRY."
      );
    }

    this.contract = new ethers.Contract(registryAddress, REGISTRY_ABI, provider);
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async register(
    options: CreateLinkOptions,
    signerProvider: ethers.BrowserProvider | ethers.JsonRpcProvider
  ): Promise<{ declarationId: Bytes32; paymentUrl: string; txHash: string }> {
    const signerAddr = await this.signer.getAddress();
    const recipient = (options.recipient ?? signerAddr) as Address;
    const tokenAddress = this.currencyToAddress(options.currency);

    const contractWithSigner = this.contract.connect(
      await signerProvider.getSigner()
    ) as ethers.Contract;

    const tx = await contractWithSigner.register(tokenAddress, options.amount);
    const receipt = await tx.wait();

    // Parse DeclarationRegistered event
    const iface = new ethers.Interface(REGISTRY_ABI);
    let declarationId: Bytes32 = "0x" as Bytes32;

    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === "DeclarationRegistered") {
          declarationId = parsed.args["declarationId"] as Bytes32;
          break;
        }
      } catch { /* skip unparseable logs */ }
    }

    const paymentUrl = `${this.appUrl}/pay/${declarationId}`;

    return { declarationId, paymentUrl, txHash: receipt.hash };
  }

  // ── Resolve ───────────────────────────────────────────────────────────────

  async resolve(declarationId: Bytes32): Promise<PaymentDeclaration> {
    const [recipient, recipientToken, amount, registeredAt, active] =
      await this.contract.resolve(declarationId);

    const currency = this.addressToCurrency(recipientToken as Address);

    return {
      declarationId,
      recipient: recipient as Address,
      recipientToken: recipientToken as Address,
      currency,
      amount: BigInt(amount),
      registeredAt: Number(registeredAt),
      active,
      paymentUrl: `${this.appUrl}/pay/${declarationId}`,
    };
  }

  // ── Parse from URL ────────────────────────────────────────────────────────

  async parseUrl(url: string): Promise<PaymentDeclaration> {
    const match = url.match(/\/pay\/(0x[0-9a-fA-F]{64})/);
    if (!match?.[1]) {
      throw new Error(`Invalid Conduit payment URL: ${url}`);
    }
    return this.resolve(match[1] as Bytes32);
  }

  // ── Deactivate ────────────────────────────────────────────────────────────

  async deactivate(
    declarationId: Bytes32,
    signerProvider: ethers.BrowserProvider | ethers.JsonRpcProvider
  ): Promise<string> {
    const contractWithSigner = this.contract.connect(
      await signerProvider.getSigner()
    ) as ethers.Contract;

    const tx = await contractWithSigner.deactivate(declarationId);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  // ── List by recipient ─────────────────────────────────────────────────────

  async getByRecipient(recipient: Address): Promise<Bytes32[]> {
    return await this.contract.getByRecipient(recipient);
  }

  async getDeclarationsForRecipient(recipient: Address): Promise<PaymentDeclaration[]> {
    const ids: Bytes32[] = await this.getByRecipient(recipient);
    return Promise.all(ids.map((id) => this.resolve(id)));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  currencyToAddress(currency: Currency): Address {
    switch (currency) {
      case "USDC": return ARC_TESTNET.tokens.USDC;
      case "EURC": return ARC_TESTNET.tokens.EURC;
    }
  }

  addressToCurrency(address: Address): Currency {
    const lower = address.toLowerCase();
    if (lower === ARC_TESTNET.tokens.USDC.toLowerCase()) return "USDC";
    if (lower === ARC_TESTNET.tokens.EURC.toLowerCase()) return "EURC";
    throw new Error(`Unknown token address: ${address}`);
  }
}
