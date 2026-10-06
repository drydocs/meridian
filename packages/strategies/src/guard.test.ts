import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_EXECUTION_ENV_VAR,
  StrategyIsolationViolationError,
  assertSimulationOnly,
  guardStrategyAction,
  isLiveExecutionEnabled,
} from "./guard";

const SOURCE_ROOT = fileURLToPath(new URL(".", import.meta.url));

function collectFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(entryPath);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
  });
}

/**
 * Every source file the engine ships. Test files are the harness that proves
 * the boundary rather than part of it, and they carry contract addresses as
 * fixtures.
 */
function engineSources(): { path: string; contents: string }[] {
  return collectFiles(SOURCE_ROOT)
    .filter((path) => !path.endsWith(".test.ts"))
    .map((path) => ({ path, contents: readFileSync(path, "utf8") }));
}

describe("strategy isolation guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("live execution flag", () => {
    it("is off in whatever configuration runs this suite", () => {
      expect(process.env[LIVE_EXECUTION_ENV_VAR]).toBeUndefined();
      expect(isLiveExecutionEnabled()).toBe(false);
    });

    it("is off unless the variable is exactly 'true'", () => {
      for (const value of ["", "1", "TRUE", "yes"]) {
        vi.stubEnv(LIVE_EXECUTION_ENV_VAR, value);
        expect(isLiveExecutionEnabled()).toBe(false);
      }

      vi.stubEnv(LIVE_EXECUTION_ENV_VAR, "true");
      expect(isLiveExecutionEnabled()).toBe(true);
    });
  });

  describe("assertSimulationOnly", () => {
    it("throws for a submit attempt while the engine is unlaunched", () => {
      expect(() => assertSimulationOnly("submitTransaction")).toThrow(
        StrategyIsolationViolationError
      );
    });

    it("names the blocked operation and the variable that lifts the boundary", () => {
      expect(() => assertSimulationOnly("submitTransaction")).toThrow(
        /submitTransaction/
      );
      expect(() => assertSimulationOnly("submitTransaction")).toThrow(
        new RegExp(`${LIVE_EXECUTION_ENV_VAR}=true`)
      );
    });

    it("returns once live execution is enabled", () => {
      vi.stubEnv(LIVE_EXECUTION_ENV_VAR, "true");
      expect(() => assertSimulationOnly("submitTransaction")).not.toThrow();
    });
  });

  describe("guardStrategyAction", () => {
    it("rejects without running the guarded action", async () => {
      let called = false;

      await expect(
        guardStrategyAction("vaultDeposit", () => {
          called = true;
          return "tx-hash";
        })
      ).rejects.toThrow(StrategyIsolationViolationError);

      expect(called).toBe(false);
    });

    it("runs the action and resolves with its value once live execution is enabled", async () => {
      vi.stubEnv(LIVE_EXECUTION_ENV_VAR, "true");

      await expect(guardStrategyAction("vaultDeposit", () => 42)).resolves.toBe(
        42
      );
    });
  });

  describe("the engine's own sources", () => {
    const sources = engineSources();

    it("reach no signing or submission surface", () => {
      const forbidden = [
        "Keypair",
        "TransactionBuilder",
        "submitTx",
        "prepareSorobanTx",
        "buildAddTrustlineTx",
        "sendTransaction",
      ];

      for (const { path, contents } of sources) {
        for (const name of forbidden) {
          expect(contents, `${path} references ${name}`).not.toContain(name);
        }
      }
    });

    it("hold no deployed contract address", () => {
      const contractId = /\bC[A-Z2-7]{55}\b/;

      for (const { path, contents } of sources) {
        expect(
          contractId.test(contents),
          `${path} contains a contract address`
        ).toBe(false);
      }
    });

    it("do not import the deployed contract address table", () => {
      for (const { path, contents } of sources) {
        expect(contents, `${path} imports CONTRACT_ADDRESSES`).not.toContain(
          "CONTRACT_ADDRESSES"
        );
      }
    });
  });
});
