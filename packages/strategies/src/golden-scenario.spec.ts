import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Decimal } from "./decimal";
import type { RawSelfRepayingLoanConfig } from "./config";
import {
  SelfRepayingLoanStrategy,
  type SelfRepayingLoanState,
  type StrategyOrder,
} from "./self-repaying-loan";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    readonly currentLtv: string;
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
    openingLoanToValue: Decimal.from("0.50"),
    deleverageBuffer: Decimal.from("0.05"),
    deleverageTargetLtv: Decimal.from("0.55"),
    liquidationThreshold: Decimal.from("0.75"),
    liquidationPenalty: Decimal.from("0.08"),
    borrowRate: {
      mode: "fixed",
      fixedRate: Decimal.from("0.05"),
    },
  };

  const strategy = new SelfRepayingLoanStrategy(baseConfig);
  const snapshots: RunSnapshot[] = [];

  // Step 0: Open
  const openRes = strategy.open({
    collateralAmount: Decimal.from("10000"),
    collateralPrice: Decimal.from("0.20"),
  });

  const recordSnapshot = (
    step: number,
    type: string,
    state: SelfRepayingLoanState,
    orders: readonly StrategyOrder[]
  ) => {
    const ltv = strategy.computeCurrentLtv(state);
    const hf = strategy.computeHealthFactor(state);

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
        currentLtv: ltv.toString(),
        healthFactor: hf ? hf.toString() : null,
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

  recordSnapshot(0, "open", openRes.nextState, openRes.orders);

  // Amortization schedule steps
  const yieldAccruals = [
    { yield: "150", interest: "0.01", price: "0.20" },
    { yield: "200", interest: "0.01", price: "0.21" },
    { yield: "250", interest: "0.01", price: "0.22" },
    { yield: "300", interest: "0.005", price: "0.22" },
    { yield: "300", interest: "0.00", price: "0.25" },
  ];

  let currentState = openRes.nextState;
  for (let i = 0; i < yieldAccruals.length; i++) {
    const entry = yieldAccruals[i]!;
    const amortizeRes = strategy.amortize({
      state: currentState,
      yieldAccrued: Decimal.from(entry.yield),
      borrowInterestRatePeriod: Decimal.from(entry.interest),
      collateralPrice: Decimal.from(entry.price),
    });
    currentState = amortizeRes.nextState;
    recordSnapshot(i + 1, "amortize", currentState, amortizeRes.orders);
  }

  // Final step: Close
  const closeRes = strategy.close({
    state: currentState,
    collateralPrice: Decimal.from("0.25"),
  });
  recordSnapshot(
    yieldAccruals.length + 1,
    "close",
    closeRes.nextState,
    closeRes.orders
  );

  return snapshots;
}

describe("Golden Scenario Determinism", () => {
  const goldenFilePath = path.join(
    __dirname,
    "../test-fixtures/scenario-golden.json"
  );

  it("pins full scenario run snapshot sequence against golden fixture", () => {
    const actualSnapshots = runScenario();

    // If UPDATE_GOLDEN=true is explicitly set in env, update the file
    if (process.env.UPDATE_GOLDEN === "true") {
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

    const expectedContent = fs.readFileSync(goldenFilePath, "utf-8");
    const expectedSnapshots = JSON.parse(expectedContent);

    expect(actualSnapshots).toEqual(expectedSnapshots);
  });
});
