/**
 * The engine runs simulations. It may read market data over RPC, and it may not
 * sign or submit, so an unlaunched strategy cannot reach real funds.
 *
 * The flag that would lift that boundary is a build-time property rather than a
 * runtime switch. It is read from `MERIDIAN_STRATEGIES_LIVE_EXECUTION`, and any
 * value other than the exact string "true" leaves the engine in simulation
 * mode, so a missing, empty or misspelled value fails closed. There is no
 * setter: the single place a launch flips this is that variable in the
 * deployment that runs strategies.
 */

export const LIVE_EXECUTION_ENV_VAR = "MERIDIAN_STRATEGIES_LIVE_EXECUTION";

export class StrategyIsolationViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrategyIsolationViolationError";
  }
}

export function isLiveExecutionEnabled(): boolean {
  return process.env[LIVE_EXECUTION_ENV_VAR] === "true";
}

export function assertSimulationOnly(operationName: string): void {
  if (isLiveExecutionEnabled()) {
    return;
  }
  throw new StrategyIsolationViolationError(
    `Blocked "${operationName}". The strategies engine is unlaunched and may not sign or submit a transaction. Set ${LIVE_EXECUTION_ENV_VAR}=true to lift the boundary.`
  );
}

export async function guardStrategyAction<T>(
  actionName: string,
  action: () => Promise<T> | T
): Promise<T> {
  assertSimulationOnly(actionName);
  return await action();
}
