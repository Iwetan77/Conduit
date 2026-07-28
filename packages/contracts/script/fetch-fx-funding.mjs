#!/usr/bin/env node
// Real StableFX quote -> sign -> trade -> presign -> sign flow, called via
// forge's vm.ffi from test/ConduitRouter.fork.t.sol. No mocking: every call
// here is a real HTTP request to the StableFX sandbox, and both signatures
// are real EIP-712 signatures from the payer's actual private key.
//
// Usage: node fetch-fx-funding.mjs <payerPrivateKey> <fromSymbol> <toSymbol> <settleAmountHuman> <recipientAddress>
// Prints ABI-encoded (bytes) result to stdout for Solidity to abi.decode.

import { ethers } from "ethers";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const STABLEFX_BASE = "https://api-sandbox.circle.com";

function loadApiKey() {
  if (process.env.STABLEFX_API_KEY) return process.env.STABLEFX_API_KEY;
  const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "api", ".env");
  const line = readFileSync(envPath, "utf8").split("\n").find((l) => l.startsWith("STABLEFX_API_KEY="));
  return line.slice("STABLEFX_API_KEY=".length).trim();
}

async function getJSON(path, apiKey) {
  const res = await fetch(STABLEFX_BASE + path, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const json = await res.json();
  if (res.status !== 200) {
    throw new Error(`${path} failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json.data;
}

async function postJSON(path, body, apiKey) {
  const res = await fetch(STABLEFX_BASE + path, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`${path} failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json.data;
}

async function main() {
  const [payerPrivateKey, fromSymbol, toSymbol, settleAmountHuman, recipientAddress] = process.argv.slice(2);
  const apiKey = loadApiKey();
  const wallet = new ethers.Wallet(payerPrivateKey);

  // 1. Quote
  const quote = await postJSON("/v1/exchange/stablefx/quotes", {
    from: { currency: fromSymbol },
    to: { currency: toSymbol, amount: settleAmountHuman },
    tenor: "instant",
    type: "tradable",
    recipientAddress,
  }, apiKey);

  // 2. Sign the quote's typed data (sig #1) and create the trade
  const td = quote.typedData;
  const quoteSig = await wallet.signTypedData(td.domain, stripDomainType(td.types), td.message);

  let trade = await postJSON("/v1/exchange/stablefx/trades", {
    idempotencyKey: quote.id,
    quoteId: quote.id,
    address: wallet.address,
    message: td.message,
    signature: quoteSig,
  }, apiKey);

  // Trade creation is async: Circle's relayer calls FxEscrow.recordTrade()
  // on-chain (both taker+maker signed permits) before a contractTradeId
  // exists. Poll GET /trades/:id until it shows up (status observed to move
  // pending -> pending_settlement). Not documented anywhere; found by testing.
  for (let i = 0; i < 20 && !trade.contractTradeId; i++) {
    await new Promise((r) => setTimeout(r, 500));
    trade = await getJSON(`/v1/exchange/stablefx/trades/${trade.id}`, apiKey);
  }
  if (!trade.contractTradeId) {
    throw new Error(`trade ${trade.id} never got a contractTradeId (status=${trade.status}) after polling`);
  }

  // 3. Presign funding, sign it (sig #2)
  const presign = await postJSON("/v1/exchange/stablefx/signatures/funding/presign", {
    contractTradeIds: [trade.contractTradeId],
    type: "taker",
  }, apiKey);

  const ftd = presign.typedData;
  const fundingSig = await wallet.signTypedData(ftd.domain, stripDomainType(ftd.types), ftd.message);

  // Submit the funding signature to CIRCLE, not to Permit2 ourselves — see
  // the architecture finding this script's testing surfaced: the permit's
  // "spender" is Circle's own relayer contract, so only Circle's backend can
  // successfully call Permit2.permitWitnessTransferFrom with this signature.
  // ConduitRouter.executeWithFX (which tries to call Permit2 directly from
  // OUR contract) can never succeed against a real StableFX signature.
  await postJSON("/v1/exchange/stablefx/fund", {
    type: "taker",
    signature: fundingSig,
    permit2: {
      permitted: { token: ftd.message.permitted.token, amount: ftd.message.permitted.amount },
      spender: ftd.message.spender,
      nonce: ftd.message.nonce,
      deadline: ftd.message.deadline,
      witness: ftd.message.witness,
    },
  }, apiKey);

  // Poll trade status until settlement completes (or fails) on-chain.
  let final = trade;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    final = await getJSON(`/v1/exchange/stablefx/trades/${trade.id}`, apiKey);
    if (final.status === "settled" || final.status === "failed" || final.status === "breached") break;
  }

  const result = {
    contractTradeId: trade.contractTradeId,
    finalStatus: final.status,
    contractTransactions: final.contractTransactions,
    payerAmount: quote.from.amount,
    settleAmount: settleAmountHuman,
  };

  console.log(JSON.stringify(result, null, 2));
}

function stripDomainType(types) {
  const { EIP712Domain, ...rest } = types;
  return rest;
}


main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
