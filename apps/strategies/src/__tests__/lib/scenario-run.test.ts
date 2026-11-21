import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRegimeScenario,
  scenarioClock,
  serializeSnapshots,
} from "@meridian/strategies";
import {
  MAX_SYNTHETIC_STEPS,
  regimeMarket,
  runScenario,
  syntheticHistory,
} from "../../lib/scenario-run";
import type { ScenarioRun, ScenarioRunOutcome } from "../../lib/scenario-run";
import {
  presetValues,
  toScenarioInput,
  toSyntheticMarket,
} from "../../lib/scenario-form";
import type { ScenarioFormValues } from "../../lib/scenario-form";

function buyAndHold(
  overrides: Partial<ScenarioFormValues> = {}
): ScenarioFormValues {
  return { ...presetValues("trending", "buy-and-hold"), ...overrides };
}

function run(values: ScenarioFormValues): Promise<ScenarioRunOutcome> {
  return runScenario(toScenarioInput(values), toSyntheticMarket(values));
}

function expectRun(outcome: ScenarioRunOutcome): ScenarioRun {
  if (!outcome.ok) {
    throw new Error(`expected a run, got ${outcome.error.message}`);
  }
  return outcome.run;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runScenario", () => {
  it("runs the default buy-and-hold preset and reports the run totals", async () => {
    const result = expectRun(await run(buyAndHold())).result;

    expect(result.strategyName).toBe("buy-and-hold");
    expect(result.snapshots).toHaveLength(25);
    expect(result.initialCash.toString()).toBe("10000");
    expect(result.totalInterest.toStroops()).toBeGreaterThan(0n);
    expect(result.totalFunding.toString()).toBe("0");
    expect(result.totalFees.toString()).toBe("0");
  });

  it("is deterministic for an identical scenario", async () => {
    const first = expectRun(await run(buyAndHold())).result;
    const second = expectRun(await run(buyAndHold())).result;

    expect(serializeSnapshots(second.snapshots)).toBe(
      serializeSnapshots(first.snapshots)
    );
    expect(second.finalValue.toString()).toBe(first.finalValue.toString());
  });

  it("changes the price path when the seed changes", async () => {
    const first = expectRun(await run(buyAndHold())).result;
    const reseeded = expectRun(await run(buyAndHold({ seed: "other" }))).result;

    expect(reseeded.finalValue.toString()).not.toBe(
      first.finalValue.toString()
    );
  });

  it("runs every regime preset with the delta-neutral strategy", async () => {
    for (const regime of ["trending", "ranging", "high-funding"] as const) {
      const outcome = await run(presetValues(regime, "delta-neutral"));
      const { scenario, market, result } = expectRun(outcome);

      expect(result.strategyName).toBe("delta-neutral");
      expect(scenario.strategy.version).toBe("1.0.0");
      expect(market.regime).toBe(regime);
    }
  });

  it("makes no network request", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network disabled in tests");
    });
    vi.stubGlobal("fetch", fetchSpy);

    expectRun(await run(buyAndHold({ priceSource: "defillama" })));
    expectRun(await run(buyAndHold({ rateSource: "defindex" })));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns field-qualified validation messages keyed by field path", async () => {
    const outcome = await run(
      buyAndHold({ startingCapital: "0", windowEnd: "2023-11-14T00:00:00Z" })
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.error.kind !== "validation") {
      throw new Error("expected a validation error");
    }
    expect(outcome.error.fields["startingCapital"]).toBe(
      "startingCapital: startingCapital must be greater than zero"
    );
    expect(outcome.error.fields["window.end"]).toBe(
      "window.end: window.end must be after window.start"
    );
  });

  it("rejects an asset the synthetic market cannot price", async () => {
    const outcome = await run(buyAndHold({ assets: "USDC, ABCD" }));

    expect(outcome).toMatchObject({
      ok: false,
      error: { kind: "validation", fields: { assets: expect.any(String) } },
    });
  });

  it("rejects a window that would not fit on the main thread", async () => {
    const outcome = await run(
      buyAndHold({
        windowStart: "2023-01-01T00:00:00Z",
        windowEnd: "2024-01-01T00:00:00Z",
        windowStep: "PT1M",
      })
    );

    expect(outcome).toMatchObject({
      ok: false,
      error: {
        kind: "validation",
        fields: {
          "window.step": expect.stringContaining(`${MAX_SYNTHETIC_STEPS}`),
        },
      },
    });
  });

  it("rejects a malformed cash rate", async () => {
    const outcome = await run(buyAndHold({ cashRateAnnual: "5%" }));

    expect(outcome).toMatchObject({
      ok: false,
      error: {
        kind: "validation",
        fields: { "market.cashRateAnnual": expect.any(String) },
      },
    });
  });

  it("reports an unknown strategy version as a typed error", async () => {
    const outcome = await run(buyAndHold({ strategyVersion: "9.9.9" }));

    expect(outcome).toEqual({
      ok: false,
      error: {
        kind: "unknown-strategy",
        message:
          "Unknown strategy 'buy-and-hold' version '9.9.9'. Available: buy-and-hold@1.0.0, delta-neutral@1.0.0.",
        strategyId: "buy-and-hold",
        strategyVersion: "9.9.9",
        available: ["buy-and-hold@1.0.0", "delta-neutral@1.0.0"],
      },
    });
  });

  it("reports an unregistered strategy id as a typed error", async () => {
    const outcome = await run(buyAndHold({ strategyId: "martingale" }));

    expect(outcome).toMatchObject({
      ok: false,
      error: { kind: "unknown-strategy", strategyId: "martingale" },
    });
  });

  it("reports a rejected strategy param against that param", async () => {
    const outcome = await run(
      buyAndHold({ params: { asset: "USDC", extra: "1" } })
    );

    expect(outcome).toMatchObject({
      ok: false,
      error: { kind: "strategy-params", param: "extra" },
    });
  });

  it("rejects a strategy asset outside the scenario assets", async () => {
    const outcome = await run(buyAndHold({ params: { asset: "EURC" } }));

    expect(outcome).toMatchObject({
      ok: false,
      error: { kind: "strategy-params", param: "asset" },
    });
  });
});

describe("syntheticHistory", () => {
  it("records one price per tick per asset and one rate per tick", () => {
    const scenario = {
      ...buildRegimeScenario("ranging"),
      assets: ["USDC", "EURC"],
    };
    const clock = scenarioClock(scenario);
    const rows = syntheticHistory(
      scenario,
      ["USDC", "EURC"],
      clock,
      regimeMarket("ranging", "0.05")
    );

    const prices = rows.filter((row) => row.kind === "price");
    const rates = rows.filter((row) => row.kind === "rate");
    expect(prices).toHaveLength(clock.tickCount * 2);
    expect(rates).toHaveLength(clock.tickCount);
    expect(rates.every((row) => row.asset === scenario.source.rate)).toBe(true);
    expect(rates.every((row) => row.rate === "0.05")).toBe(true);
  });
});
