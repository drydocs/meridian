import { readFileSync, statSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Extracts and measures all JavaScript assets loaded or preloaded for startup.
 * Counts:
 * 1. <script type="module" src="..."> entry scripts in index.html
 * 2. <link rel="modulepreload" href="..."> statically preloaded chunks
 * 3. Any transitive static import statements inside those scripts
 */
export function getInitialJsAssets(webRoot = resolve(__dirname, "..")) {
  const indexPath = resolve(webRoot, "dist/index.html");
  if (!existsSync(indexPath)) {
    throw new Error(
      `dist/index.html not found at: ${indexPath}. Run vite build first.`
    );
  }

  const indexHtml = readFileSync(indexPath, "utf-8");
  const assetsMap = new Map();

  // Match all <script src="...js">
  const scriptMatches = [
    ...indexHtml.matchAll(/<script[^>]+src=["']([^"'>]+\.js)["']/gi),
  ];
  for (const match of scriptMatches) {
    const rawSrc = match[1];
    const relativeAsset = rawSrc.replace(/^\/app\//, "").replace(/^\//, "");
    const assetPath = resolve(webRoot, "dist", relativeAsset);
    if (existsSync(assetPath)) {
      assetsMap.set(assetPath, { file: relativeAsset, type: "entry" });
    }
  }

  // Match all <link rel="modulepreload" href="...js"> (order of rel and href may vary)
  const preloadMatches = [
    ...indexHtml.matchAll(
      /<link[^>]+rel=["']modulepreload["'][^>]+href=["']([^"'>]+\.js)["']/gi
    ),
    ...indexHtml.matchAll(
      /<link[^>]+href=["']([^"'>]+\.js)["'][^>]+rel=["']modulepreload["']/gi
    ),
  ];
  for (const match of preloadMatches) {
    const rawHref = match[1];
    const relativeAsset = rawHref.replace(/^\/app\//, "").replace(/^\//, "");
    const assetPath = resolve(webRoot, "dist", relativeAsset);
    if (existsSync(assetPath) && !assetsMap.has(assetPath)) {
      assetsMap.set(assetPath, { file: relativeAsset, type: "modulepreload" });
    }
  }

  // Also trace static imports in collected files to catch any un-preloaded static dependencies
  const visited = new Set();
  const queue = [...assetsMap.keys()];

  while (queue.length > 0) {
    const currentPath = queue.shift();
    if (visited.has(currentPath)) continue;
    visited.add(currentPath);

    try {
      const code = readFileSync(currentPath, "utf-8");
      const importMatches = [
        ...code.matchAll(
          /(?:import|export)\s*[^;]*?from\s*["'](\.[^"']+\.js)["']/g
        ),
      ];
      const dir = dirname(currentPath);
      for (const m of importMatches) {
        const importedPath = resolve(dir, m[1]);
        if (existsSync(importedPath) && !assetsMap.has(importedPath)) {
          const relativeAsset = importedPath
            .replace(resolve(webRoot, "dist"), "")
            .replace(/^[\\/]/, "");
          assetsMap.set(importedPath, {
            file: relativeAsset,
            type: "static-import",
          });
          queue.push(importedPath);
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  const assets = [];
  let totalBytes = 0;
  for (const [path, info] of assetsMap.entries()) {
    const size = statSync(path).size;
    totalBytes += size;
    assets.push({ ...info, path, size });
  }

  return { assets, totalBytes };
}

/**
 * Evaluates whether measured initial JS bytes meet the budget and baseline reduction.
 */
export function evaluateBundleBudget(report, initialJsBytes) {
  const { baseline, budget } = report;
  const reductionPercent = Number(
    ((1 - initialJsBytes / baseline.initialJsBytes) * 100).toFixed(1)
  );

  if (initialJsBytes >= baseline.initialJsBytes) {
    return {
      passed: false,
      initialJsBytes,
      baselineBytes: baseline.initialJsBytes,
      budgetBytes: budget.maxInitialJsBytes,
      reductionPercent,
      error: `Initial JS (${initialJsBytes} bytes) is not less than baseline (${baseline.initialJsBytes} bytes)!`,
    };
  }

  if (initialJsBytes > budget.maxInitialJsBytes) {
    return {
      passed: false,
      initialJsBytes,
      baselineBytes: baseline.initialJsBytes,
      budgetBytes: budget.maxInitialJsBytes,
      reductionPercent,
      error: `Initial JS (${(initialJsBytes / 1024).toFixed(2)} KB) exceeds budget limit of ${(budget.maxInitialJsBytes / 1024).toFixed(2)} KB!`,
    };
  }

  return {
    passed: true,
    initialJsBytes,
    baselineBytes: baseline.initialJsBytes,
    budgetBytes: budget.maxInitialJsBytes,
    reductionPercent,
  };
}

/**
 * Runs the bundle budget check against dist and bundle-report.json.
 */
export function runBundleCheck({
  webRoot = resolve(__dirname, ".."),
  reportPath = resolve(webRoot, "bundle-report.json"),
} = {}) {
  if (!existsSync(reportPath)) {
    throw new Error(`Bundle report not found at: ${reportPath}`);
  }

  const report = JSON.parse(readFileSync(reportPath, "utf-8"));
  const { assets, totalBytes } = getInitialJsAssets(webRoot);
  const evaluation = evaluateBundleBudget(report, totalBytes);

  console.log("\n=== Meridian Bundle Budget Gate ===");
  console.log(
    `Baseline Initial JS: ${(evaluation.baselineBytes / 1024).toFixed(2)} KB`
  );
  console.log(
    `Budget Limit:        ${(evaluation.budgetBytes / 1024).toFixed(2)} KB`
  );
  console.log(
    `Actual Initial JS:   ${(evaluation.initialJsBytes / 1024).toFixed(2)} KB`
  );
  console.log("\nInitial Startup Assets:");
  for (const asset of assets) {
    console.log(
      `  - [${asset.type}] ${asset.file}: ${(asset.size / 1024).toFixed(2)} KB`
    );
  }
  console.log(
    `\nBundle reduction:    ${evaluation.reductionPercent}% vs baseline`
  );

  if (!evaluation.passed) {
    console.error(`\n❌ BUDGET GATE FAILED: ${evaluation.error}\n`);
    return evaluation;
  }

  console.log("\n✅ Bundle budget check PASSED within limits.\n");
  return evaluation;
}

const isDirectExecution =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  try {
    const result = runBundleCheck();
    if (!result.passed) {
      process.exit(1);
    }
  } catch (err) {
    console.error(`\n❌ Gate execution failed: ${err.message}\n`);
    process.exit(1);
  }
}
