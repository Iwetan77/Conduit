import type { Address } from "./types.js";

export const ARC_TESTNET = {
  chainId: 5042002,
  rpc: "https://rpc.testnet.arc.network",
  ws: "wss://rpc.testnet.arc.network",
  explorer: "https://testnet.arcscan.app",
  name: "Arc Testnet",

  tokens: {
    USDC: "0x3600000000000000000000000000000000000000" as Address,
    EURC: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" as Address,
  },

  contracts: {
    // Populated by Deploy.s.sol — fill from .env after deployment
    conduitRouter: (process.env["NEXT_PUBLIC_CONDUIT_ROUTER"] ?? "") as Address,
    declarationRegistry: (process.env["NEXT_PUBLIC_DECLARATION_REGISTRY"] ?? "") as Address,
    stableFXAdapter: (process.env["NEXT_PUBLIC_STABLEFX_ADAPTER"] ?? "") as Address,
    atomicSettler: (process.env["NEXT_PUBLIC_ATOMIC_SETTLER"] ?? "") as Address,

    // Arc native (immutable)
    stableFXEscrow: "0x867650F5eAe8df91445971f14d89fd84F0C9a9f8" as Address,
    cctpTokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as Address,
    cctpMessageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275" as Address,
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
    multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address,
  },

  cctp: {
    domain: 26,
    fastFinalityThreshold: 1000,
  },
} as const;

// Token decimals — always ERC-20 (6), never native (18)
export const TOKEN_DECIMALS: Record<string, number> = {
  [ARC_TESTNET.tokens.USDC.toLowerCase()]: 6,
  [ARC_TESTNET.tokens.EURC.toLowerCase()]: 6,
};

// Default payment link base URL
export const DEFAULT_APP_URL = "https://app.conduit.xyz";

// Default quote TTL (seconds)
export const QUOTE_TTL_SECONDS = 30;

// Max protocol fee safety cap (30 bps)
export const MAX_FEE_BPS = 30n;

// ERC-20 minimal ABI
export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
] as const;

// ConduitRouter minimal ABI
export const ROUTER_ABI = [
  // Same-currency: USDC→USDC or EURC→EURC
  "function execute((address payer, address recipient, address payerToken, address recipientToken, uint256 amount, uint256 deadline, bytes32 declarationId) instruction) external returns (bytes32 receiptId)",
  // Cross-currency: Permit2 funding data from Circle StableFX API
  "function executeWithFX((address payer, address recipient, address payerToken, address recipientToken, uint256 amount, uint256 deadline, bytes32 declarationId) instruction, ((address token, uint256 amount) permitted, uint256 nonce, uint256 deadline) permit, (address to, uint256 requestedAmount) transferDetails, bytes32 witness, string witnessTypeString, bytes fundingSignature) external returns (bytes32 receiptId)",
  "function quote((address payer, address recipient, address payerToken, address recipientToken, uint256 amount, uint256 deadline, bytes32 declarationId) instruction) external view returns (uint256 payerAmount)",
  "event PaymentSettled(bytes32 indexed receiptId, address indexed payer, address indexed recipient, address payerToken, address recipientToken, uint256 payerAmount, uint256 recipientAmount, bytes32 declarationId, uint256 settledAt)",
] as const;

// DeclarationRegistry minimal ABI
export const REGISTRY_ABI = [
  "function register(address recipientToken, uint256 amount) external returns (bytes32 declarationId)",
  "function resolve(bytes32 declarationId) external view returns (address recipient, address recipientToken, uint256 amount, uint256 registeredAt, bool active)",
  "function deactivate(bytes32 declarationId) external",
  "function isActive(bytes32 declarationId) external view returns (bool)",
  "function getByRecipient(address recipient) external view returns (bytes32[] memory)",
  "event DeclarationRegistered(bytes32 indexed declarationId, address indexed recipient, address recipientToken, uint256 amount)",
] as const;
