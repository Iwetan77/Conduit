import type { Address } from "./types.js";

// ── Contract addresses ──────────────────────────────────────────────────────
// No hardcoded fallback addresses. Resolution order:
//   1. NEXT_PUBLIC_* env vars (how the Next.js app injects them at build time)
//   2. deployments/arc-testnet.json (written by `forge script Deploy.s.sol`,
//      read here for server/agent/script usage that isn't going through Next)
// If neither source has an address, this throws at import time — loudly, at
// boot, rather than silently deploying against a stale/wrong address baked
// into source. See CONDUIT-B2B-ARCHITECTURE.md delta: "Hardcoded contract
// address fallbacks... Addresses come from deployments/arc-testnet.json or
// the process fails loudly at boot."

interface DeploymentFile {
  chainId?: number;
  conduitRouter?: string;
  declarationRegistry?: string;
  stableFXAdapter?: string;
  atomicSettler?: string;
  currencyRegistry?: string;
  settlementPreferenceRegistry?: string;
}

function loadDeploymentFile(): DeploymentFile {
  // Browser bundles never hit this — `typeof window` guards it out, and
  // bundlers dead-code-eliminate the `require`/`fs` branch entirely.
  if (typeof window !== "undefined") return {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("node:path") as typeof import("node:path");
    // Walk up from this file looking for a repo-root deployments/arc-testnet.json.
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, "deployments", "arc-testnet.json");
      if (fs.existsSync(candidate)) {
        return JSON.parse(fs.readFileSync(candidate, "utf8")) as DeploymentFile;
      }
      dir = path.dirname(dir);
    }
  } catch {
    // fall through to env-only resolution
  }
  return {};
}

const deployment = loadDeploymentFile();

// Next.js only inlines *literal* `process.env.NEXT_PUBLIC_X` member
// expressions into browser bundles — a dynamic `process.env[envVar]` lookup
// compiles to `undefined` in the browser even when .env.local is correct
// (this was the real cause of the "address not found" errors on /create and
// /history). Each var must be read with the literal dot form, once, here.
const ENV_ADDRESSES: Record<string, string | undefined> = {
  NEXT_PUBLIC_CONDUIT_ROUTER: process.env.NEXT_PUBLIC_CONDUIT_ROUTER,
  NEXT_PUBLIC_DECLARATION_REGISTRY: process.env.NEXT_PUBLIC_DECLARATION_REGISTRY,
  NEXT_PUBLIC_STABLEFX_ADAPTER: process.env.NEXT_PUBLIC_STABLEFX_ADAPTER,
  NEXT_PUBLIC_ATOMIC_SETTLER: process.env.NEXT_PUBLIC_ATOMIC_SETTLER,
  NEXT_PUBLIC_CURRENCY_REGISTRY: process.env.NEXT_PUBLIC_CURRENCY_REGISTRY,
  NEXT_PUBLIC_SETTLEMENT_PREFERENCE_REGISTRY: process.env.NEXT_PUBLIC_SETTLEMENT_PREFERENCE_REGISTRY,
};

function resolveAddress(envVar: string, deploymentKey: keyof DeploymentFile, label: string): Address {
  const fromEnv = ENV_ADDRESSES[envVar];
  const fromFile = deployment[deploymentKey] as string | undefined;
  const value = fromEnv || fromFile;
  if (!value) {
    throw new Error(
      `${label} address not found. Set ${envVar}, or run ` +
      `\`forge script script/Deploy.s.sol --broadcast\` to generate deployments/arc-testnet.json. ` +
      `Refusing to fall back to a hardcoded address.`
    );
  }
  return value as Address;
}

export const ARC_TESTNET = {
  chainId: 5042002,
  rpc: "https://rpc.testnet.arc.network",
  ws: "wss://rpc.testnet.arc.network",
  explorer: "https://testnet.arcscan.app",
  name: "Arc Testnet",

  // USDC/EURC addresses are stable, publicly-documented Arc testnet infra
  // (verified on-chain in Phase 0), not protocol deployments — kept as
  // constants rather than routed through the deployment file. Contract
  // addresses (below) ARE Conduit's own deployments and must not be hardcoded.
  tokens: {
    USDC: "0x3600000000000000000000000000000000000000" as Address,
    EURC: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" as Address,
  },

  contracts: {
    get conduitRouter(): Address {
      return resolveAddress("NEXT_PUBLIC_CONDUIT_ROUTER", "conduitRouter", "ConduitRouter");
    },
    get declarationRegistry(): Address {
      return resolveAddress("NEXT_PUBLIC_DECLARATION_REGISTRY", "declarationRegistry", "DeclarationRegistry");
    },
    get stableFXAdapter(): Address {
      return resolveAddress("NEXT_PUBLIC_STABLEFX_ADAPTER", "stableFXAdapter", "StableFXAdapter");
    },
    get atomicSettler(): Address {
      return resolveAddress("NEXT_PUBLIC_ATOMIC_SETTLER", "atomicSettler", "AtomicSettler");
    },
    get currencyRegistry(): Address {
      return resolveAddress("NEXT_PUBLIC_CURRENCY_REGISTRY", "currencyRegistry", "CurrencyRegistry");
    },
    get settlementPreferenceRegistry(): Address {
      return resolveAddress(
        "NEXT_PUBLIC_SETTLEMENT_PREFERENCE_REGISTRY",
        "settlementPreferenceRegistry",
        "SettlementPreferenceRegistry"
      );
    },

    // Arc native (immutable)
    stableFXEscrow: "0x867650F5eAe8df91445971f14d89fd84F0C9a9f8" as Address,
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
    multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address,
  },
} as const;

// Base URL for generated payment links and QR codes.
//
// This is baked into every QR a merchant prints, so a wrong value doesn't
// degrade gracefully — it sends a paying customer to somebody else's website.
// app.conduit.xyz was a placeholder we never owned, and QRs generated with it
// did exactly that.
//
// In the browser the app's own origin is authoritative: a link created on the
// site you're using should point back at the site you're using. Falls back to
// the configured public URL, then to production.
export const DEFAULT_APP_URL =
  (typeof window !== "undefined" && window.location.origin) ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "https://useconduit.xyz";

// Default quote TTL (seconds) — same-currency quote() call, not StableFX RFQ
// (StableFX quotes are ~3.5s TTL, measured live in Phase 0 — see docs/fx-capability.md).
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
  // Same-currency direct send
  "function execute((address payer, address recipient, address payerToken, address recipientToken, uint256 amount, uint256 deadline, bytes32 declarationId) instruction) external returns (bytes32 receiptId)",
  // Cross-currency via Circle StableFX + Permit2 funding data
  "function executeWithFX((address payer, address recipient, address payerToken, address recipientToken, uint256 amount, uint256 deadline, bytes32 declarationId) instruction, ((address token, uint256 amount) permitted, uint256 nonce, uint256 deadline) permit, (address to, uint256 requestedAmount) transferDetails, bytes32 witness, string witnessTypeString, bytes fundingSignature) external returns (bytes32 receiptId)",
  "function quote((address payer, address recipient, address payerToken, address recipientToken, uint256 amount, uint256 deadline, bytes32 declarationId) instruction) external view returns (uint256 payerAmount)",
  "event PaymentSettled(bytes32 indexed receiptId, address indexed payer, address indexed recipient, address payerToken, address recipientToken, uint256 payerAmount, uint256 recipientAmount, bytes32 declarationId, uint256 settledAt)",
  // Custom errors, so a revert arrives decoded instead of as raw bytes. Without
  // this entry the recipient's standing settlement preference rejecting a
  // payment -- a designed, explainable outcome -- reached the payer as a bare
  // "execution reverted", which reads as the network being broken.
  "error PreferenceMismatch(address recipient, address preferenceToken, address instructionToken)",
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
