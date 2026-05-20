// Deploys only StableFXAdapter and updates packages/app/.env.local with the new address.
// Usage: PRIVATE_KEY=0x... node deploy-adapter.mjs

import { ethers } from "ethers";
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dir = dirname(fileURLToPath(import.meta.url));

const RPC = "https://rpc.testnet.arc.network";
const CHAIN_ID = 5042002;
const ENV_LOCAL = resolve(__dir, "../app/.env.local");

const privateKey = process.env.PRIVATE_KEY;
if (!privateKey) {
  console.error("Error: PRIVATE_KEY env var is required.");
  console.error("Usage: PRIVATE_KEY=0x... node deploy-adapter.mjs");
  process.exit(1);
}

// Compile via forge
console.log("Compiling contracts...");
try {
  execSync("~/.foundry/bin/forge build", { cwd: __dir, stdio: "inherit" });
} catch {
  console.error("Forge build failed. Is foundry installed?");
  process.exit(1);
}

// Read compiled artifact
const artifact = JSON.parse(
  readFileSync(resolve(__dir, "out/StableFXAdapter.sol/StableFXAdapter.json"), "utf8")
);
const abi = artifact.abi;
const bytecode = artifact.bytecode.object;

const provider = new ethers.JsonRpcProvider(RPC, { chainId: CHAIN_ID, name: "arc-testnet" });
const wallet = new ethers.Wallet(privateKey, provider);
const deployer = await wallet.getAddress();

console.log(`\nDeployer: ${deployer}`);
console.log(`Chain ID: ${CHAIN_ID}`);
console.log(`RPC:      ${RPC}\n`);

const factory = new ethers.ContractFactory(abi, bytecode, wallet);
console.log("Deploying StableFXAdapter...");
const contract = await factory.deploy(deployer); // deployer = owner
await contract.waitForDeployment();
const newAddress = await contract.getAddress();
console.log(`\nStableFXAdapter deployed: ${newAddress}`);

// Update packages/app/.env.local
let env = readFileSync(ENV_LOCAL, "utf8");
env = env.replace(
  /NEXT_PUBLIC_STABLEFX_ADAPTER=.*/,
  `NEXT_PUBLIC_STABLEFX_ADAPTER=${newAddress}`
);
writeFileSync(ENV_LOCAL, env);
console.log(`Updated packages/app/.env.local`);
console.log(`\nDone! Restart your dev server.`);
