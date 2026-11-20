import { readFileSync, statSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(__dirname, "..");
const reportPath = resolve(webRoot, "bundle-report.json");
const indexPath = resolve(webRoot, "dist/index.html");

if (!existsSync(reportPath)) {
  console.error("Bundle report not found at:", reportPath);
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, "utf-8"));
const { baseline, budget } = report;

if (!existsSync(indexPath)) {
  console.error("dist/index.html not found. Run vite build first.");
  process.exit(1);
}

const indexHtml = readFileSync(indexPath, "utf-8");
const scriptMatches = [...indexHtml.matchAll(/<script[^>]+src="([^">]+)"/g)];

if (scriptMatches.length === 0) {
  console.error("No script tags found in dist/index.html.");
  process.exit(1);
}

let totalInitialJsBytes = 0;
const entryScripts = [];

for (const match of scriptMatches) {
  const scriptSrc = match[1];
  // Remove base "/app/" if present
  const relativeAsset = scriptSrc.replace(/^\/app\//, "");
  const assetPath = resolve(webRoot, "dist", relativeAsset);

  if (existsSync(assetPath)) {
    const size = statSync(assetPath).size;
    totalInitialJsBytes += size;
    entryScripts.push({ file: relativeAsset, size });
  } else {
    console.warn("Asset not found on disk:", assetPath);
  }
}

console.log("\n=== Meridian Bundle Budget Gate ===");
console.log(
  `Baseline Initial JS: ${(baseline.initialJsBytes / 1024).toFixed(2)} KB`
);
console.log(
  `Budget Limit:        ${(budget.maxInitialJsBytes / 1024).toFixed(2)} KB`
);
console.log(
  `Actual Initial JS:   ${(totalInitialJsBytes / 1024).toFixed(2)} KB`
);

for (const script of entryScripts) {
  console.log(`  - ${script.file}: ${(script.size / 1024).toFixed(2)} KB`);
}

const reduction = (
  (1 - totalInitialJsBytes / baseline.initialJsBytes) *
  100
).toFixed(1);
console.log(`Bundle reduction:    ${reduction}% vs baseline`);

if (totalInitialJsBytes > budget.maxInitialJsBytes) {
  console.error(
    `\n❌ BUDGET EXCEEDED: Initial JS (${(totalInitialJsBytes / 1024).toFixed(2)} KB) ` +
      `exceeds budget limit of ${(budget.maxInitialJsBytes / 1024).toFixed(2)} KB!`
  );
  process.exit(1);
}

if (totalInitialJsBytes >= baseline.initialJsBytes) {
  console.error(
    `\n❌ NO REDUCTION: Initial JS (${totalInitialJsBytes} bytes) ` +
      `is not less than baseline (${baseline.initialJsBytes} bytes)!`
  );
  process.exit(1);
}

console.log("\n✅ Bundle budget check PASSED within limits.\n");
