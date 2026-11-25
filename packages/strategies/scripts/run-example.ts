import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FixedPointDecimal,
  KNOWN_ASSETS,
  parseScenario,
  resolveStrategy,
  runBacktest,
  scenarioClock,
  scenarioPriceFeed,
} from "../src/index";
import type { AssetSymbol, ResolvedStrategy } from "../src/index";
import { targetWeightDefinition } from "../examples/target-weight-strategy";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_SCENARIO_PATH = resolve(
  PACKAGE_ROOT,
  "examples/target-weight.scenario.json"
);

function parseScenarioPath(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--scenario") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("--scenario requires a file path");
      }
      return resolve(process.cwd(), next);
    }
    if (arg.startsWith("--scenario=")) {
      const value = arg.slice("--scenario=".length);
      if (!value) {
        throw new Error("--scenario requires a file path");
      }
      return resolve(process.cwd(), value);
    }
  }
  return DEFAULT_SCENARIO_PATH;
}

function toAssetSymbols(assets: readonly string[]): AssetSymbol[] {
  return assets.map((asset) => {
    if (!KNOWN_ASSETS.has(asset)) {
      throw new Error(`Unsupported scenario asset: ${asset}`);
    }
    return asset as AssetSymbol;
  });
}

function main(): void {
  const scenarioPath = parseScenarioPath(process.argv.slice(2));
  const rawJson: unknown = JSON.parse(readFileSync(scenarioPath, "utf8"));
  const scenario = parseScenario(rawJson);

  const clock = scenarioClock(scenario);
  const prices = scenarioPriceFeed(scenario);
  const assets = toAssetSymbols(scenario.assets);

  let resolved: ResolvedStrategy;
  if (
    scenario.strategy.id === targetWeightDefinition.id &&
    scenario.strategy.version === targetWeightDefinition.version
  ) {
    resolved = targetWeightDefinition.resolve(scenario.strategy.params, {
      priceFeed: prices,
    });
  } else {
    resolved = resolveStrategy(
      scenario.strategy.id,
      scenario.strategy.version,
      scenario.strategy.params,
      { priceFeed: prices }
    );
  }

  const result = runBacktest({
    clock,
    assets,
    prices,
    strategy: resolved.strategy,
    strategyConfig: resolved.config,
    initialCash: FixedPointDecimal.fromString(scenario.startingCapital),
  });

  const pnl = result.finalValue.sub(result.initialCash);

  const summary = {
    strategy: `${scenario.strategy.id}@${scenario.strategy.version}`,
    seed: scenario.seed,
    assets: scenario.assets,
    ticks: result.snapshots.length,
    initialCash: result.initialCash.toString(),
    finalValue: result.finalValue.toString(),
    strategyEquity: result.strategyEquity.toString(),
    pnl: pnl.toString(),
    totalFees: result.totalFees.toString(),
    totalInterest: result.totalInterest.toString(),
    totalFunding: result.totalFunding.toString(),
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main();
