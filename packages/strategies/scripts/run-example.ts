import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BacktestPriceFeed,
  FixedPointDecimal,
  KNOWN_ASSETS,
  STRATEGY_DEFINITIONS,
  UnknownStrategyError,
  generateGbmPath,
  parseScenario,
  runBacktest,
  scenarioClock,
  seedToBigInt,
} from "../src/index";
import type {
  AssetSymbol,
  BacktestResult,
  Scenario,
  StrategyDefinition,
} from "../src/index";
import { thresholdRebalanceDefinition } from "../examples/threshold-rebalance-strategy";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_EXAMPLE_SCENARIO_PATH = resolve(
  PACKAGE_ROOT,
  "examples/scenario.json"
);

export interface ExampleCliArgs {
  readonly scenarioPath: string;
}

export function parseExampleCliArgs(argv: readonly string[]): ExampleCliArgs {
  let scenarioPath = DEFAULT_EXAMPLE_SCENARIO_PATH;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--scenario") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("--scenario requires a file path");
      }
      scenarioPath = resolve(process.cwd(), next);
      i += 1;
      continue;
    }
    throw new Error(`Unknown CLI argument: ${String(arg)}`);
  }
  return { scenarioPath };
}

function buildDeterministicFeed(scenario: Scenario): BacktestPriceFeed {
  const clock = scenarioClock(scenario);
  const startPrice = scenario.strategy.params["market.startPrice"] ?? "1";
  const drift = scenario.strategy.params["market.drift"] ?? "0";
  const volatility = scenario.strategy.params["market.volatility"] ?? "0.005";

  const series: Partial<
    Record<AssetSymbol, Array<{ timestamp: number; price: FixedPointDecimal }>>
  > = {};

  for (const [assetIndex, rawAsset] of scenario.assets.entries()) {
    if (!KNOWN_ASSETS.has(rawAsset)) {
      throw new Error(`Unsupported scenario asset: ${rawAsset}`);
    }
    const asset = rawAsset as AssetSymbol;
    const path = generateGbmPath({
      startPrice,
      drift,
      volatility,
      steps: clock.stepCount,
      seed: seedToBigInt(`${scenario.seed}:${assetIndex}`),
    });
    series[asset] = path.map((price, tickIndex) => ({
      timestamp: clock.timestampAt(tickIndex),
      price,
    }));
  }

  return BacktestPriceFeed.create(series);
}

export function formatExampleSummary(
  scenario: Scenario,
  result: BacktestResult
): string {
  const pnl = FixedPointDecimal.fromStroops(
    result.finalValue.toStroops() - result.initialCash.toStroops()
  );
  return [
    `strategy: ${scenario.strategy.id}@${scenario.strategy.version}`,
    `window: ${scenario.window.start}..${scenario.window.end} (${scenario.window.step})`,
    `ticks: ${result.snapshots.length}`,
    `initialCash: ${result.initialCash.toString()}`,
    `finalValue: ${result.finalValue.toString()}`,
    `pnl: ${pnl.toString()}`,
    `totalFees: ${result.totalFees.toString()}`,
  ].join("\n");
}

export function runExampleScenario(scenario: Scenario): {
  readonly scenario: Scenario;
  readonly result: BacktestResult;
  readonly summary: string;
} {
  const prices = buildDeterministicFeed(scenario);
  const clock = scenarioClock(scenario);

  const definitions: readonly StrategyDefinition<unknown>[] = [
    thresholdRebalanceDefinition as StrategyDefinition<unknown>,
    ...(STRATEGY_DEFINITIONS as readonly StrategyDefinition<unknown>[]),
  ];
  const definition = definitions.find(
    (candidate) =>
      candidate.id === scenario.strategy.id &&
      candidate.version === scenario.strategy.version
  );
  if (!definition) {
    throw new UnknownStrategyError(
      scenario.strategy.id,
      scenario.strategy.version,
      definitions.map((candidate) => `${candidate.id}@${candidate.version}`)
    );
  }

  const resolved = definition.resolve(scenario.strategy.params, {
    priceFeed: prices,
  });
  const result = runBacktest({
    clock,
    assets: scenario.assets as AssetSymbol[],
    prices,
    strategy: resolved.strategy,
    strategyConfig: resolved.config,
    initialCash: FixedPointDecimal.fromString(scenario.startingCapital),
  });

  return {
    scenario,
    result,
    summary: formatExampleSummary(scenario, result),
  };
}

export function runExampleCli(
  argv: readonly string[],
  write: (text: string) => void = (text) => {
    process.stdout.write(text);
  }
): string {
  const { scenarioPath } = parseExampleCliArgs(argv);
  const raw = JSON.parse(readFileSync(scenarioPath, "utf8")) as unknown;
  const { summary } = runExampleScenario(parseScenario(raw));
  write(`${summary}\n`);
  return summary;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runExampleCli(process.argv.slice(2));
}
