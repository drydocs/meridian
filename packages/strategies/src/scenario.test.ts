import { describe, it, expect } from "vitest";
import {
  SCENARIO_SCHEMA_VERSION,
  PRICE_SOURCES,
  RATE_SOURCES,
  ScenarioSchema,
  ScenarioValidationError,
  formatScenarioError,
  parseScenario,
  safeParseScenario,
} from "./scenario";
import type { Scenario } from "./scenario";

/**
 * Minimal valid scenario, deliberately omitting `schemaVersion` and
 * `strategy.params` so the default-application tests below can exercise them.
 */
const VALID_INPUT = {
  window: {
    start: "2024-01-01T00:00:00Z",
    end: "2024-02-01T00:00:00Z",
    step: "PT1H",
  },
  assets: ["USDC", "EURC"],
  source: { price: "horizon", rate: "blend" },
  startingCapital: "10000",
  strategy: {
    id: "blend-loop",
    version: "1.0.0",
    params: { targetUtilization: "0.85" },
  },
  seed: "scenario-874",
} as const;

/** Returns the flattened, field-qualified error message for a failing input. */
function failureTextFor(input: unknown): string {
  const result = ScenarioSchema.safeParse(input);
  expect(result.success).toBe(false);
  if (result.success) throw new Error("expected parse to fail");
  return formatScenarioError(result.error);
}

describe("ScenarioSchema", () => {
  it("parses a valid scenario into the expected typed object", () => {
    const scenario: Scenario = parseScenario(VALID_INPUT);

    expect(scenario).toEqual({
      schemaVersion: SCENARIO_SCHEMA_VERSION,
      window: {
        start: "2024-01-01T00:00:00Z",
        end: "2024-02-01T00:00:00Z",
        step: "PT1H",
      },
      assets: ["USDC", "EURC"],
      source: { price: "horizon", rate: "blend" },
      startingCapital: "10000",
      strategy: {
        id: "blend-loop",
        version: "1.0.0",
        params: { targetUtilization: "0.85" },
      },
      seed: "scenario-874",
    });
    expect(scenario.schemaVersion).toBe(SCENARIO_SCHEMA_VERSION);
  });

  it("defaults schemaVersion and strategy.params when omitted", () => {
    const scenario = parseScenario({
      ...VALID_INPUT,
      strategy: { id: "blend-loop", version: "1.0.0" },
    });

    expect(scenario.schemaVersion).toBe(SCENARIO_SCHEMA_VERSION);
    expect(scenario.strategy.params).toEqual({});
  });

  it("accepts every declared price and rate source", () => {
    for (const price of PRICE_SOURCES) {
      for (const rate of RATE_SOURCES) {
        const result = ScenarioSchema.safeParse({
          ...VALID_INPUT,
          source: { price, rate },
        });
        expect(result.success).toBe(true);
      }
    }
  });

  it("is deterministic: the same input always yields the same scenario", () => {
    expect(parseScenario(VALID_INPUT)).toEqual(parseScenario(VALID_INPUT));
  });

  it("accepts a fixed-point value with the full 7 fractional digits", () => {
    const scenario = parseScenario({
      ...VALID_INPUT,
      startingCapital: "1.1234567",
    });
    expect(scenario.startingCapital).toBe("1.1234567");
  });

  it("rejects a fixed-point value with more than 7 fractional digits", () => {
    const message = failureTextFor({
      ...VALID_INPUT,
      startingCapital: "1.12345678",
    });
    expect(message).toContain("startingCapital");
    expect(message).toContain("7 decimal places");
  });
});

describe("ScenarioSchema monetary fields reject floats", () => {
  it("rejects a number for startingCapital (no floats)", () => {
    const message = failureTextFor({ ...VALID_INPUT, startingCapital: 10000 });
    expect(message).toContain("startingCapital");
  });

  it("rejects a fractional number for startingCapital (no floats)", () => {
    const message = failureTextFor({
      ...VALID_INPUT,
      startingCapital: 10000.5,
    });
    expect(message).toContain("startingCapital");
  });

  it("rejects a negative startingCapital with a specific message", () => {
    const message = failureTextFor({ ...VALID_INPUT, startingCapital: "-100" });
    expect(message).toContain("startingCapital");
    expect(message).toContain("non-negative");
  });

  it("rejects a zero startingCapital", () => {
    const message = failureTextFor({ ...VALID_INPUT, startingCapital: "0" });
    expect(message).toContain("startingCapital must be greater than zero");
  });

  it("rejects a number-valued strategy param (no floats in config)", () => {
    const message = failureTextFor({
      ...VALID_INPUT,
      strategy: { id: "s", version: "1.0.0", params: { rate: 0.05 } },
    });
    expect(message).toContain("strategy.params.rate");
  });
});

describe("ScenarioSchema window validation", () => {
  it("rejects a window whose end is not after its start", () => {
    const message = failureTextFor({
      ...VALID_INPUT,
      window: {
        start: "2024-02-01T00:00:00Z",
        end: "2024-01-01T00:00:00Z",
        step: "PT1H",
      },
    });
    expect(message).toContain("window.end must be after window.start");
  });

  it("rejects a window whose end equals its start", () => {
    const message = failureTextFor({
      ...VALID_INPUT,
      window: {
        start: "2024-01-01T00:00:00Z",
        end: "2024-01-01T00:00:00Z",
        step: "PT1H",
      },
    });
    expect(message).toContain("window.end must be after window.start");
  });

  it("rejects a non-ISO start instant naming window.start", () => {
    const message = failureTextFor({
      ...VALID_INPUT,
      window: { ...VALID_INPUT.window, start: "2024-01-01" },
    });
    expect(message).toContain("window.start");
    expect(message).toContain("ISO-8601");
  });

  it("rejects a non-duration step naming window.step", () => {
    const message = failureTextFor({
      ...VALID_INPUT,
      window: { ...VALID_INPUT.window, step: "1h" },
    });
    expect(message).toContain("window.step");
  });
});

describe("ScenarioSchema asset list validation", () => {
  it("rejects an empty asset list", () => {
    const message = failureTextFor({ ...VALID_INPUT, assets: [] });
    expect(message).toContain("assets must contain at least one asset symbol");
  });

  it("rejects duplicate asset symbols", () => {
    const message = failureTextFor({
      ...VALID_INPUT,
      assets: ["USDC", "USDC"],
    });
    expect(message).toContain("duplicate");
  });

  it("rejects a malformed asset symbol naming the index", () => {
    const message = failureTextFor({ ...VALID_INPUT, assets: ["usdc"] });
    expect(message).toContain("assets.0");
    expect(message).toContain("uppercase asset symbol");
  });
});

describe("ScenarioSchema source validation", () => {
  it("rejects an unknown price source naming source.price", () => {
    const message = failureTextFor({
      ...VALID_INPUT,
      source: { price: "oracle", rate: "blend" },
    });
    expect(message).toContain(
      "source.price must be one of: horizon, defillama"
    );
  });

  it("rejects an unknown rate source naming source.rate", () => {
    const message = failureTextFor({
      ...VALID_INPUT,
      source: { price: "horizon", rate: "defillama" },
    });
    expect(message).toContain("source.rate must be one of: blend, defindex");
  });
});

describe("ScenarioSchema strictness and required fields", () => {
  it("rejects an unknown top-level key instead of dropping it", () => {
    const message = failureTextFor({ ...VALID_INPUT, notAField: 1 });
    expect(message).toContain("notAField");
  });

  it("rejects an unknown key inside a nested block", () => {
    const message = failureTextFor({
      ...VALID_INPUT,
      window: { ...VALID_INPUT.window, extraWindowKey: true },
    });
    expect(message).toContain("extraWindowKey");
  });

  it("reports every missing required field", () => {
    const message = failureTextFor({});
    for (const field of [
      "window",
      "assets",
      "source",
      "startingCapital",
      "strategy",
      "seed",
    ]) {
      expect(message).toContain(field);
    }
  });
});

describe("parseScenario", () => {
  it("returns a fully typed scenario for valid input", () => {
    const scenario = parseScenario(VALID_INPUT);
    expect(scenario.assets).toEqual(["USDC", "EURC"]);
    expect(scenario.source.rate).toBe("blend");
  });

  it("throws a ScenarioValidationError naming the offending field", () => {
    expect(() =>
      parseScenario({ ...VALID_INPUT, startingCapital: "-1" })
    ).toThrow(ScenarioValidationError);

    try {
      parseScenario({ ...VALID_INPUT, startingCapital: "-1" });
      throw new Error("expected parseScenario to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ScenarioValidationError);
      const validationError = error as ScenarioValidationError;
      expect(validationError.message).toContain("startingCapital");
      expect(validationError.issues.length).toBeGreaterThan(0);
    }
  });
});

describe("safeParseScenario", () => {
  it("returns the parsed data on success", () => {
    const result = safeParseScenario(VALID_INPUT);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.seed).toBe("scenario-874");
    }
  });

  it("returns a ScenarioValidationError instead of throwing", () => {
    const result = safeParseScenario({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ScenarioValidationError);
      expect(result.error.message).toContain("window");
    }
  });
});

describe("formatScenarioError", () => {
  it("dot-joins the field path into the message", () => {
    const result = ScenarioSchema.safeParse({
      ...VALID_INPUT,
      source: { price: "horizon", rate: "nope" },
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected parse to fail");
    expect(formatScenarioError(result.error)).toBe(
      "source.rate: source.rate must be one of: blend, defindex"
    );
  });

  it("labels an object-level issue with (root)", () => {
    const result = ScenarioSchema.safeParse({ ...VALID_INPUT, extra: true });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected parse to fail");
    expect(formatScenarioError(result.error)).toContain("(root)");
  });
});
