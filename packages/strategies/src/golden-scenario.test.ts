import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { RawSelfRepayingLoanConfig } from "./config";
import { Decimal } from "./decimal";
import {
  SelfRepayingLoanStrategy,
  type SelfRepayingLoanState,
  type StrategyOrder,
} from "./self-repaying-loan";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

interface RunSnapshot {
  readonly step: number;
  readonly type: string;
  readonly state: {
    readonly collateralAmount: string;
    readonly collateralPrice: string;
    readonly debtAmount: string;
    readonly yieldDeployedPrincipal: string;
    readonly totalYieldAmortized: string;
    readonly totalInterestAccrued: string;
    readonly currentLtv: string | null;
    readonly healthFactor: string | null;
    readonly isOpen: boolean;
    readonly isClosed: boolean;
  };
  readonly orders: ReadonlyArray<{
    readonly type: string;
    readonly asset: string;
    readonly amount: string;
    readonly target?: string | undefined;
  }>;
}

function runScenario(): RunSnapshot[] {
  const baseConfig: RawSelfRepayingLoanConfig = {
    collateralAsset: "XLM",
    borrowAsset: "USDC",
    yieldSource: "blend-pool",
    openingLoanToValue: Decimal.fromString("0.50"),
    deleverageBuffer: Decimal.fromString("0.05"),
    deleverageTargetLtv: Decimal.fromString("0.55"),
    liquidationThreshold: Decimal.fromString("0.75"),
    liquidationPenalty: Decimal.fromString("0.08"),
    borrowRate: {
      mode: "fixed",
      fixedRate: Decimal.fromString("0.05"),
    },
  };

  const strategy = new SelfRepayingLoanStrategy(baseConfig);
  const snapshots: RunSnapshot[] = [];

  const recordSnapshot = (
    step: number,
    type: string,
    state: SelfRepayingLoanState,
    orders: readonly StrategyOrder[]
  ) => {
    snapshots.push({
      step,
      type,
      state: {
        collateralAmount: state.collateralAmount.toString(),
        collateralPrice: state.collateralPrice.toString(),
        debtAmount: state.debtAmount.toString(),
        yieldDeployedPrincipal: state.yieldDeployedPrincipal.toString(),
        totalYieldAmortized: state.totalYieldAmortized.toString(),
        totalInterestAccrued: state.totalInterestAccrued.toString(),
        currentLtv: strategy.computeCurrentLtv(state)?.toString() ?? null,
        healthFactor: strategy.computeHealthFactor(state)?.toString() ?? null,
        isOpen: state.isOpen,
        isClosed: state.isClosed,
      },
      orders: orders.map((o) => ({
        type: o.type,
        asset: o.asset,
        amount: o.amount.toString(),
        ...(o.target ? { target: o.target } : {}),
      })),
    });
  };

  // Step 0: open 10,000 XLM at $0.20 for a $1,000 USDC borrow at 50% LTV.
  const openRes = strategy.open({
    collateralAmount: Decimal.fromString("10000"),
    collateralPrice: Decimal.fromString("0.20"),
  });
  recordSnapshot(0, "open", openRes.nextState, openRes.orders);

  const schedule = [
    { yield: "150", interest: "0.01", price: "0.20" },
    { yield: "200", interest: "0.01", price: "0.21" },
    { yield: "250", interest: "0.01", price: "0.22" },
    { yield: "300", interest: "0.005", price: "0.22" },
    { yield: "300", interest: "0.00", price: "0.25" },
  ];

  let currentState = openRes.nextState;
  for (const [i, entry] of schedule.entries()) {
    const amortizeRes = strategy.amortize({
      state: currentState,
      yieldAccrued: Decimal.fromString(entry.yield),
      borrowInterestRatePeriod: Decimal.fromString(entry.interest),
      collateralPrice: Decimal.fromString(entry.price),
    });
    currentState = amortizeRes.nextState;
    recordSnapshot(i + 1, "amortize", currentState, amortizeRes.orders);
  }

  const closeRes = strategy.close({
    state: currentState,
    collateralPrice: Decimal.fromString("0.25"),
  });
  recordSnapshot(
    schedule.length + 1,
    "close",
    closeRes.nextState,
    closeRes.orders
  );

  return snapshots;
}

describe("Golden Scenario Determinism", () => {
  const goldenFilePath = path.join(
    currentDir,
    "../test-fixtures/scenario-golden.json"
  );

  it("matches the recorded snapshot sequence for a fixed scenario", () => {
    const actualSnapshots = runScenario();

    if (process.env.UPDATE_GOLDEN === "true") {
      if (process.env.CI) {
        throw new Error(
          "Refusing to regenerate the golden fixture under CI. Run UPDATE_GOLDEN=true locally and review the diff before committing it."
        );
      }

      fs.mkdirSync(path.dirname(goldenFilePath), { recursive: true });
      fs.writeFileSync(
        goldenFilePath,
        JSON.stringify(actualSnapshots, null, 2) + "\n",
        "utf-8"
      );
    }

    expect(
      fs.existsSync(goldenFilePath),
      `Golden fixture file missing at ${goldenFilePath}. To generate intentionally, run UPDATE_GOLDEN=true pnpm test.`
    ).toBe(true);

    const expectedSnapshots = JSON.parse(
      fs.readFileSync(goldenFilePath, "utf-8")
    ) as RunSnapshot[];

    expect(actualSnapshots).toEqual(expectedSnapshots);
  });
});
