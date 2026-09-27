import { FixedPointDecimal } from "./types";
import type { AssetSymbol, SimulationTimestamp } from "./types";

// Bump this constant whenever the serialized shape changes in a
// backward-incompatible way. deserializeRunReport rejects any report whose
// version field does not match CURRENT_REPORT_VERSION with a loud error.
export const CURRENT_REPORT_VERSION = 1;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface RunScenario {
  /** Human-readable label for the scenario (e.g. "USDC bull 2024-Q1"). */
  label: string;
  /** Inclusive start of the simulation window (ms since Unix epoch). */
  startTimestamp: SimulationTimestamp;
  /** Inclusive end of the simulation window (ms since Unix epoch). */
  endTimestamp: SimulationTimestamp;
  /** Assets tracked during the run. */
  assets: AssetSymbol[];
}

export interface RiskMetrics {
  /** Maximum observed peak-to-trough drawdown, expressed as a fraction (0–1). */
  maxDrawdown: FixedPointDecimal;
  /** Annualised Sharpe ratio (excess return per unit of volatility). */
  sharpeRatio: FixedPointDecimal;
  /** Annualised volatility of portfolio returns. */
  annualisedVolatility: FixedPointDecimal;
  /** Total return over the simulation window, expressed as a fraction. */
  totalReturn: FixedPointDecimal;
}

export interface EventCounts {
  /** Number of rebalance events executed. */
  rebalances: number;
  /** Number of price-feed ticks consumed. */
  priceTicks: number;
  /** Number of times the stop-loss threshold was breached. */
  stopLossTriggers: number;
  /** Number of times the take-profit threshold was breached. */
  takeProfitTriggers: number;
}

export interface PortfolioPosition {
  asset: AssetSymbol;
  /** Quantity held at the end of the run. */
  quantity: FixedPointDecimal;
  /** Spot price of the asset at the final timestamp. */
  lastPrice: FixedPointDecimal;
}

export interface FinalPortfolioState {
  /** Timestamp of the last processed tick. */
  timestamp: SimulationTimestamp;
  /** Per-asset positions at the end of the run. */
  positions: PortfolioPosition[];
  /** Aggregate portfolio value in the base currency at the final timestamp. */
  totalValue: FixedPointDecimal;
}

export interface RunReport {
  /** Format version — used by deserializeRunReport to detect stale payloads. */
  version: number;
  scenario: RunScenario;
  riskMetrics: RiskMetrics;
  eventCounts: EventCounts;
  finalState: FinalPortfolioState;
}

// ---------------------------------------------------------------------------
// Serialized (JSON-safe) counterparts — FixedPointDecimal → string
// ---------------------------------------------------------------------------

interface SerializedRiskMetrics {
  maxDrawdown: string;
  sharpeRatio: string;
  annualisedVolatility: string;
  totalReturn: string;
}

interface SerializedPortfolioPosition {
  asset: AssetSymbol;
  quantity: string;
  lastPrice: string;
}

interface SerializedFinalPortfolioState {
  timestamp: SimulationTimestamp;
  positions: SerializedPortfolioPosition[];
  totalValue: string;
}

export interface SerializedRunReport {
  version: number;
  scenario: RunScenario; // no FixedPointDecimal fields, already plain
  riskMetrics: SerializedRiskMetrics;
  eventCounts: EventCounts; // plain numbers
  finalState: SerializedFinalPortfolioState;
}

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

export function serializeRunReport(report: RunReport): SerializedRunReport {
  return {
    version: report.version,
    scenario: { ...report.scenario, assets: [...report.scenario.assets] },
    riskMetrics: {
      maxDrawdown: report.riskMetrics.maxDrawdown.toString(),
      sharpeRatio: report.riskMetrics.sharpeRatio.toString(),
      annualisedVolatility: report.riskMetrics.annualisedVolatility.toString(),
      totalReturn: report.riskMetrics.totalReturn.toString(),
    },
    eventCounts: { ...report.eventCounts },
    finalState: {
      timestamp: report.finalState.timestamp,
      totalValue: report.finalState.totalValue.toString(),
      positions: report.finalState.positions.map((p) => ({
        asset: p.asset,
        quantity: p.quantity.toString(),
        lastPrice: p.lastPrice.toString(),
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Deserialize
// ---------------------------------------------------------------------------

export class UnknownReportVersionError extends Error {
  readonly found: number;
  readonly expected: number;

  constructor(found: number, expected: number) {
    super(
      `Unsupported run-report version ${found}; this build only understands version ${expected}. ` +
        `Upgrade @meridian/strategies or re-generate the report.`
    );
    this.name = "UnknownReportVersionError";
    this.found = found;
    this.expected = expected;
  }
}

export function isUnknownReportVersionError(
  error: unknown
): error is UnknownReportVersionError {
  return error instanceof UnknownReportVersionError;
}

export function deserializeRunReport(raw: SerializedRunReport): RunReport {
  if (raw.version !== CURRENT_REPORT_VERSION) {
    throw new UnknownReportVersionError(raw.version, CURRENT_REPORT_VERSION);
  }

  return {
    version: raw.version,
    scenario: { ...raw.scenario, assets: [...raw.scenario.assets] },
    riskMetrics: {
      maxDrawdown: FixedPointDecimal.fromString(raw.riskMetrics.maxDrawdown),
      sharpeRatio: FixedPointDecimal.fromString(raw.riskMetrics.sharpeRatio),
      annualisedVolatility: FixedPointDecimal.fromString(
        raw.riskMetrics.annualisedVolatility
      ),
      totalReturn: FixedPointDecimal.fromString(raw.riskMetrics.totalReturn),
    },
    eventCounts: { ...raw.eventCounts },
    finalState: {
      timestamp: raw.finalState.timestamp,
      totalValue: FixedPointDecimal.fromString(raw.finalState.totalValue),
      positions: raw.finalState.positions.map((p) => ({
        asset: p.asset,
        quantity: FixedPointDecimal.fromString(p.quantity),
        lastPrice: FixedPointDecimal.fromString(p.lastPrice),
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// JSON helpers (convenience wrappers around serialize / deserialize)
// ---------------------------------------------------------------------------

export function runReportToJSON(report: RunReport): string {
  return JSON.stringify(serializeRunReport(report));
}

export function runReportFromJSON(json: string): RunReport {
  const raw = JSON.parse(json) as SerializedRunReport;
  return deserializeRunReport(raw);
}

// ---------------------------------------------------------------------------
// Warm-start support
// ---------------------------------------------------------------------------

/**
 * A WarmStartContext carries the minimum information needed to resume a run
 * from the point where a previous report ended rather than replaying the
 * full history.
 *
 * Usage:
 *   1. Finish a run and capture its RunReport.
 *   2. Call buildWarmStartContext(report) to extract the resume point.
 *   3. Pass the WarmStartContext to your simulation engine.  The engine can
 *      skip all price-feed ticks whose timestamp ≤ context.resumeTimestamp
 *      and initialise portfolio positions from context.positions.
 */
export interface WarmStartContext {
  /** The timestamp from which the continued run should pick up (exclusive:
   *  the next tick processed must be strictly after this timestamp). */
  resumeTimestamp: SimulationTimestamp;
  /** Per-asset positions to seed the warm-started engine. */
  positions: PortfolioPosition[];
  /** Total portfolio value at the resume point. */
  totalValue: FixedPointDecimal;
  /** The scenario the original run covered, so the engine can validate that
   *  the warm-started window is a contiguous extension. */
  originalScenario: RunScenario;
}

export function buildWarmStartContext(report: RunReport): WarmStartContext {
  return {
    resumeTimestamp: report.finalState.timestamp,
    positions: report.finalState.positions.map((p) => ({ ...p })),
    totalValue: report.finalState.totalValue,
    originalScenario: {
      ...report.scenario,
      assets: [...report.scenario.assets],
    },
  };
}

export class WarmStartScenarioMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WarmStartScenarioMismatchError";
  }
}

export function isWarmStartScenarioMismatchError(
  error: unknown
): error is WarmStartScenarioMismatchError {
  return error instanceof WarmStartScenarioMismatchError;
}

/**
 * Validates that a warm-start context is compatible with the provided
 * extension scenario before the simulation engine consumes it.
 *
 * Throws WarmStartScenarioMismatchError when:
 *  - The extension scenario covers assets not present in the original run.
 *  - The extension window does not start where the original run ended.
 */
export function validateWarmStart(
  ctx: WarmStartContext,
  extensionScenario: RunScenario
): void {
  const originalAssets = new Set(ctx.originalScenario.assets);
  for (const asset of extensionScenario.assets) {
    if (!originalAssets.has(asset)) {
      throw new WarmStartScenarioMismatchError(
        `Extension scenario includes asset "${asset}" that was not part of the original run ` +
          `(original assets: ${[...originalAssets].join(", ")}).`
      );
    }
  }

  if (extensionScenario.startTimestamp <= ctx.resumeTimestamp) {
    throw new WarmStartScenarioMismatchError(
      `Extension scenario start (${new Date(extensionScenario.startTimestamp).toISOString()}) ` +
        `must be strictly after the resume timestamp ` +
        `(${new Date(ctx.resumeTimestamp).toISOString()}). ` +
        `The warm-started window must be a contiguous extension of the original run.`
    );
  }
}
