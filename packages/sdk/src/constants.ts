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

function resolveAddress(envVar: string, deploymentKey: keyof DeploymentFile, label: string): Address {
  const fromEnv = typeof process !== "undefined" ? process.env[envVar] : undefined;
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

    // ArcSwap — Uniswap V2 by Arc Foundation (public Arc testnet infra, verified Phase 0)
    ammRouter: "0x48a9bd1644ac67fbef4183261c466bea3eb333fc" as Address,
    ammFactory: "0x45dd35611179ae6663ae47791175d7d598ced086" as Address,

    // UnitFlow — V2.5 AMM (Uniswap V2-compatible)
    unitflowRouter: "0x4AA8c7Ac458479d9A4FA5c1481e03061ac76824A" as Address,
    unitflowFactory: "0xd67F63A4F26a497b364d1C82e6747Aec8B5743a5" as Address,

    // Arc native (immutable)
    stableFXEscrow: "0x867650F5eAe8df91445971f14d89fd84F0C9a9f8" as Address,
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
    multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address,
  },
} as const;

// Default payment link base URL
export const DEFAULT_APP_URL = "https://app.conduit.xyz";

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
  // Cross-currency via AMM fallback (pairs StableFX refuses to quote)
  "function executeWithAmm((address payer, address recipient, address payerToken, address recipientToken, uint256 amount, uint256 deadline, bytes32 declarationId) instruction, address[] path, uint256 amountInMax, address ammRouter) external returns (bytes32 receiptId)",
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
