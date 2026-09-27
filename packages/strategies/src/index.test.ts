import { describe, it, expect } from "vitest";
import { STRATEGY_ENGINE, type StrategyEngine } from "./index";

describe("@meridian/strategies package", () => {
  it("exports STRATEGY_ENGINE with valid metadata", () => {
    expect(STRATEGY_ENGINE).toBeDefined();
    expect(STRATEGY_ENGINE.name).toBe("meridian-strategies");
    expect(STRATEGY_ENGINE.version).toBe("0.1.0");
  });

  it("satisfies StrategyEngine interface", () => {
    const customEngine: StrategyEngine = {
      name: "custom",
      version: "1.0.0",
    };
    expect(customEngine.name).toBe("custom");
  });
});
