import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_EXAMPLE_SCENARIO_PATH,
  parseExampleCliArgs,
  runExampleCli,
  runExampleScenario,
} from "../scripts/run-example";
import { thresholdRebalanceDefinition } from "../examples/threshold-rebalance-strategy";
import { StrategyParamsError, UnknownStrategyError } from "./registry";
import { parseScenario } from "./scenario";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("example strategy and CLI smoke run (#1262)", () => {
  it("runs deterministically and produces a well-formed summary with no network calls", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const lines: string[] = [];
    try {
      const first = runExampleCli([], (text) => lines.push(text));
      const second = runExampleCli([], (text) => lines.push(text));

      expect(first).toBe(second);
      expect(lines).toHaveLength(2);
      expect(first).toMatch(
        /^strategy: threshold-rebalance@1\.0\.0\nwindow: .+\nticks: 25\ninitialCash: 1000\nfinalValue: \d+(?:\.\d{1,7})?\npnl: -?\d+(?:\.\d{1,7})?\ntotalFees: 0$/
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("handles default market params, unknown strategies, and unsupported assets", () => {
    const buyHold = parseScenario({
      window: {
        start: "2024-01-01T00:00:00Z",
        end: "2024-01-01T02:00:00Z",
        step: "PT1H",
      },
      assets: ["USDC"],
      source: { price: "horizon", rate: "blend" },
      startingCapital: "500",
      strategy: {
        id: "buy-and-hold",
        version: "1.0.0",
        params: { asset: "USDC" },
      },
      seed: "defaults-seed",
    });
    expect(runExampleScenario(buyHold).summary).toContain(
      "strategy: buy-and-hold@1.0.0"
    );

    // Scenario where driftBps is wide enough that close hits with no open position
    const noTrade = parseScenario({
      window: {
        start: "2024-01-01T00:00:00Z",
        end: "2024-01-01T02:00:00Z",
        step: "PT1H",
      },
      assets: ["USDC"],
      source: { price: "horizon", rate: "blend" },
      startingCapital: "500",
      strategy: {
        id: "threshold-rebalance",
        version: "1.0.0",
        params: { asset: "USDC", targetWeight: "0.1", driftBps: "9000" },
      },
      seed: "wide-band",
    });
    expect(runExampleScenario(noTrade).result.finalValue.toString()).toBe(
      "500"
    );

    expect(() =>
      runExampleScenario({
        ...buyHold,
        strategy: { id: "missing", version: "1.0.0", params: {} },
      })
    ).toThrow(UnknownStrategyError);

    expect(() =>
      runExampleScenario({
        ...buyHold,
        assets: ["DOGE"],
      })
    ).toThrow(/Unsupported scenario asset/);
  });

  it("parses --scenario CLI arguments and rejects malformed flags", () => {
    expect(parseExampleCliArgs([])).toEqual({
      scenarioPath: DEFAULT_EXAMPLE_SCENARIO_PATH,
    });
    expect(
      parseExampleCliArgs(["--scenario", "examples/scenario.json"])
    ).toEqual({
      scenarioPath: resolve(process.cwd(), "examples/scenario.json"),
    });
    expect(() => parseExampleCliArgs(["--scenario"])).toThrow(
      /--scenario requires a file path/
    );
    expect(() => parseExampleCliArgs(["--scenario", "--bad"])).toThrow(
      /--scenario requires a file path/
    );
    expect(() => parseExampleCliArgs(["--unknown"])).toThrow(
      /Unknown CLI argument/
    );
  });

  it("validates example strategy params strictly", () => {
    expect(() =>
      thresholdRebalanceDefinition.parseParams(
        { asset: "XLM", targetWeight: "0.5", driftBps: "50", extra: "1" },
        {}
      )
    ).toThrow(StrategyParamsError);
    expect(() =>
      thresholdRebalanceDefinition.parseParams(
        { targetWeight: "0.5", driftBps: "50" },
        {}
      )
    ).toThrow(StrategyParamsError);
    expect(() =>
      thresholdRebalanceDefinition.parseParams(
        { asset: "DOGE", targetWeight: "0.5", driftBps: "50" },
        {}
      )
    ).toThrow(StrategyParamsError);
    expect(() =>
      thresholdRebalanceDefinition.parseParams(
        { asset: "XLM", targetWeight: "bad", driftBps: "50" },
        {}
      )
    ).toThrow(StrategyParamsError);
    expect(() =>
      thresholdRebalanceDefinition.parseParams(
        { asset: "XLM", targetWeight: "1.5", driftBps: "50" },
        {}
      )
    ).toThrow(StrategyParamsError);
    expect(() =>
      thresholdRebalanceDefinition.parseParams(
        { asset: "XLM", targetWeight: "0.5", driftBps: "-1" },
        {}
      )
    ).toThrow(StrategyParamsError);
  });

  it("keeps example and CLI sources free of signing and deployed contract surfaces", () => {
    const files = [
      resolve(PACKAGE_ROOT, "examples/threshold-rebalance-strategy.ts"),
      resolve(PACKAGE_ROOT, "scripts/run-example.ts"),
    ];
    const forbidden = [
      "Keypair",
      "TransactionBuilder",
      "submitTx",
      "prepareSorobanTx",
      "buildAddTrustlineTx",
      "sendTransaction",
      "CONTRACT_ADDRESSES",
    ];
    const contractId = /\bC[A-Z2-7]{55}\b/;

    for (const file of files) {
      const contents = readFileSync(file, "utf8");
      for (const symbol of forbidden) {
        expect(contents).not.toContain(symbol);
      }
      expect(contractId.test(contents)).toBe(false);
    }
  });
});
