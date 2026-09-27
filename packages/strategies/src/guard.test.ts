import { describe, it, expect, beforeEach } from "vitest";
import {
  StrategyExecutionGuard,
  StrategyIsolationViolationError,
  guardStrategyAction,
  STELLAR_MAINNET_PASSPHRASE,
  STELLAR_TESTNET_PASSPHRASE,
} from "./guard";

describe("StrategyExecutionGuard & Isolation Boundary", () => {
  beforeEach(() => {
    StrategyExecutionGuard.reset();
  });

  it("defaults to liveExecutionEnabled === false", () => {
    expect(StrategyExecutionGuard.isLiveExecutionEnabled()).toBe(false);
  });

  it("assertSimulationOnly throws when live flag is disabled", () => {
    expect(() =>
      StrategyExecutionGuard.assertSimulationOnly("submitTransaction")
    ).toThrow(StrategyIsolationViolationError);

    expect(() =>
      StrategyExecutionGuard.assertSimulationOnly("signWithKeypair")
    ).toThrow(/simulation-first mode and live execution is unlaunched/);
  });

  it("guardStrategyAction blocks execution before running inner callback", async () => {
    let called = false;
    await expect(
      guardStrategyAction("vaultDeposit", async () => {
        called = true;
        return "tx_hash_mock";
      })
    ).rejects.toThrow(StrategyIsolationViolationError);

    expect(called).toBe(false);
  });

  it("blocks connection to Stellar Mainnet passphrase by default", () => {
    expect(() =>
      StrategyExecutionGuard.assertAllowedNetwork(STELLAR_MAINNET_PASSPHRASE)
    ).toThrow(/cannot connect to Stellar Mainnet/);

    // Testnet is allowed for read-only simulations
    expect(() =>
      StrategyExecutionGuard.assertAllowedNetwork(STELLAR_TESTNET_PASSPHRASE)
    ).not.toThrow();
  });

  it("allows execution when explicitly enabled and resets safely", async () => {
    StrategyExecutionGuard.setLiveExecution(true);
    expect(StrategyExecutionGuard.isLiveExecutionEnabled()).toBe(true);

    expect(() =>
      StrategyExecutionGuard.assertSimulationOnly("submitTransaction")
    ).not.toThrow();

    expect(() =>
      StrategyExecutionGuard.assertAllowedNetwork(STELLAR_MAINNET_PASSPHRASE)
    ).not.toThrow();

    const result = await guardStrategyAction("allowedAction", () => 42);
    expect(result).toBe(42);

    StrategyExecutionGuard.reset();
    expect(StrategyExecutionGuard.isLiveExecutionEnabled()).toBe(false);
  });
});
