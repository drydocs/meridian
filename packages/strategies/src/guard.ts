/**
 * Unlaunched Strategies Boundary & Isolation Guard
 *
 * The strategies package is strictly simulation-first. Strategies and backtests
 * run in memory against mock or read-only historical market data and must NEVER
 * touch real vault contracts, live networks (mainnet), signers, or submit real transactions.
 *
 * Feature Flag:
 * - Default: OFF (`false`) in every configuration including CI.
 * - Enforces that unlaunched strategies cannot reach signing or on-chain submit pathways.
 */

export const STELLAR_MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
export const STELLAR_TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

export class StrategyIsolationViolationError extends Error {
  constructor(message: string) {
    super(`[Strategy Isolation Violation] ${message}`);
    this.name = "StrategyIsolationViolationError";
  }
}

export class StrategyExecutionGuard {
  private static liveExecutionFlag = false;

  /**
   * Check if live execution / on-chain submission is enabled. Default is false.
   */
  static isLiveExecutionEnabled(): boolean {
    return this.liveExecutionFlag;
  }

  /**
   * Set execution flag explicitly.
   */
  static setLiveExecution(enabled: boolean): void {
    this.liveExecutionFlag = enabled;
  }

  /**
   * Enforces that live transaction signing/submission cannot proceed when unlaunched.
   * Throws StrategyIsolationViolationError immediately before any network I/O or signing occurs.
   */
  static assertSimulationOnly(operationName: string): void {
    if (!this.isLiveExecutionEnabled()) {
      throw new StrategyIsolationViolationError(
        `Blocked attempt to execute '${operationName}'. Strategies are in simulation-first mode and live execution is unlaunched.`
      );
    }
  }

  /**
   * Enforces that network endpoints must not target live Mainnet while unlaunched.
   */
  static assertAllowedNetwork(networkPassphrase?: string): void {
    if (!networkPassphrase) return;
    if (networkPassphrase === STELLAR_MAINNET_PASSPHRASE && !this.isLiveExecutionEnabled()) {
      throw new StrategyIsolationViolationError(
        "Strategies engine cannot connect to Stellar Mainnet while unlaunched."
      );
    }
  }

  /**
   * Reset guard to safe default (used for test isolation).
   */
  static reset(): void {
    this.liveExecutionFlag = false;
  }
}

/**
 * Guarded action wrapper for strategy execution.
 * Any attempt to invoke real transaction signing/submission without explicit live flag throws immediately.
 */
export async function guardStrategyAction<T>(
  actionName: string,
  fn: () => Promise<T> | T
): Promise<T> {
  StrategyExecutionGuard.assertSimulationOnly(actionName);
  return await fn();
}
