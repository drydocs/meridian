#!/usr/bin/env node
// Generates N throwaway Stellar testnet keypairs and funds them with XLM via
// Friendbot, then writes their public keys (and secrets, kept only in case
// you extend this suite to a full sign-and-submit flow later — the load-test
// scripts themselves never sign anything and only need the public keys) to
// scripts/load-test/accounts.json.
//
// Testnet only, deliberately: there is no mainnet Friendbot, and this script
// takes no network argument, so it cannot accidentally target mainnet.
//
// Usage:
//   node scripts/load-test/prepare-accounts.mjs [count]
//
// Requires network access to https://friendbot.stellar.org.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(__dirname, "accounts.json");
const FRIENDBOT_URL = "https://friendbot.stellar.org";
const count = Number(process.argv[2] || 10);

if (!Number.isInteger(count) || count <= 0) {
  console.error("Usage: node scripts/load-test/prepare-accounts.mjs [count]");
  process.exit(1);
}

async function fund(publicKey) {
  const res = await fetch(
    `${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`
  );
  // Friendbot returns 400 for an account that's already funded — harmless
  // here since every key is freshly generated, kept as a defensive no-op.
  if (!res.ok && res.status !== 400) {
    throw new Error(`Friendbot funding failed: HTTP ${res.status}`);
  }
}

// How many Friendbot requests to have in flight at once. Each is
// independent, so there's no correctness reason to fund sequentially, but
// firing all of them at once risks tripping Friendbot's own rate limiting.
const FUND_CONCURRENCY = 10;

async function main() {
  console.log(`Generating and funding ${count} throwaway testnet accounts...`);
  const keypairs = Array.from({ length: count }, () => Keypair.random());
  const accounts = [];

  for (let i = 0; i < keypairs.length; i += FUND_CONCURRENCY) {
    const batch = keypairs.slice(i, i + FUND_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((kp) => fund(kp.publicKey()))
    );
    results.forEach((result, j) => {
      const kp = batch[j];
      const n = i + j + 1;
      if (result.status === "fulfilled") {
        console.log(`  [${n}/${count}] ${kp.publicKey()} ... funded`);
        accounts.push({ publicKey: kp.publicKey(), secret: kp.secret() });
      } else {
        console.log(`  [${n}/${count}] ${kp.publicKey()} ... FAILED`);
        console.error(`    ${result.reason.message}`);
      }
    });
  }

  if (accounts.length === 0) {
    console.error(
      "\nNo accounts were funded. Check network access to friendbot.stellar.org and try again."
    );
    process.exit(1);
  }

  writeFileSync(
    OUT_FILE,
    JSON.stringify(
      {
        network: "testnet",
        generatedAt: new Date().toISOString(),
        accounts,
      },
      null,
      2
    )
  );

  console.log(`\nWrote ${accounts.length} account(s) to ${OUT_FILE}`);
  console.log(
    "These are disposable testnet-only keys with no real value. Don't reuse " +
      "them for anything else. accounts.json is gitignored — never commit it."
  );
  console.log(
    "\nNote: these accounts hold XLM only, no USDC. Deposit/withdraw load " +
      "test requests will reach Soroban simulation but typically fail there " +
      "with an insufficient-balance error (HTTP 500) unless you separately " +
      "fund a subset with testnet USDC via https://testnet.blend.capital. " +
      "See README.md for details."
  );
}

main();
