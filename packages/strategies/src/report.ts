import type { AssetSymbol, SimulationTimestamp } from "./types";
import { FixedPointDecimal } from "./types";

export const REPORT_FORMAT_VERSION = 1 as const;
export type ReportFormatVersion = typeof REPORT_FORMAT_VERSION;

// The scenario that was run: what window, which assets, and what the strategy
// engine version was at the time.
export interface RunScenario {
  readonly startTimestamp: SimulationTimestamp;
  readonly endTimestamp: SimulationTimestamp;
  readonly assets: readonly AssetSymbol[];
  readonly engineVersion: string;
}

// Risk metrics summarising the run.
export interface RiskMetrics {
  // Maximum drawdown from peak portfolio value as a FixedPointDecimal ratio
  // (0 = no drawdown, 1 = total loss). Always non-negative.
  readonly maxDrawdown: FixedPointDecimal;
  // Sharpe-ratio numerator proxy: mean excess return in stroops per step.
  // Stored as FixedPointDecimal to preserve precision. Callers that don't
  // use this can leave it as zero.
  readonly sharpeProxy: FixedPointDecimal;
  // Volatility expressed as standard deviation of per-step returns.
  readonly volatility: FixedPointDecimal;
}

// Counts of discrete events that happened during the run.
export interface EventCounts {
  readonly rebalances: number;
  readonly deposits: number;
  readonly withdrawals: number;
  readonly priceFeedMisses: number;
}

// The portfolio state at the end (or at the checkpoint) of the run.
// Holdings are per asset expressed as FixedPointDecimal amounts.
export interface PortfolioState {
  readonly timestamp: SimulationTimestamp;
  readonly holdings: Readonly<Record<AssetSymbol, FixedPointDecimal>>;
  // Total portfolio value denominated in the reference asset (USDC).
  readonly totalValue: FixedPointDecimal;
}

// A complete, self-contained run report. Carries everything required to
// reproduce or resume the run.
export interface RunReport {
  readonly version: ReportFormatVersion;
  readonly scenario: RunScenario;
  readonly riskMetrics: RiskMetrics;
  readonly eventCounts: EventCounts;
  readonly finalState: PortfolioState;
}

// ─── Wire format ─────────────────────────────────────────────────────────────
// All FixedPointDecimal values are serialised as the raw bigint stroop count
// expressed as a decimal string (e.g. "10000001"). This is lossless and safe
// across JSON serialisers that would truncate large numbers.

interface SerializedRiskMetrics {
  maxDrawdown: string;
  sharpeProxy: string;
  volatility: string;
}

interface SerializedPortfolioState {
  timestamp: SimulationTimestamp;
  holdings: Record<string, string>;
  totalValue: string;
}

export interface SerializedRunReport {
  version: number;
  scenario: {
    startTimestamp: SimulationTimestamp;
    endTimestamp: SimulationTimestamp;
    assets: string[];
    engineVersion: string;
  };
  riskMetrics: SerializedRiskMetrics;
  eventCounts: EventCounts;
  finalState: SerializedPortfolioState;
}

// ─── Serialization ───────────────────────────────────────────────────────────

function serializeFixed(v: FixedPointDecimal): string {
  return v.toStroops().toString();
}

function deserializeFixed(s: string): FixedPointDecimal {
  return FixedPointDecimal.fromStroops(BigInt(s));
}

export function serializeReport(report: RunReport): SerializedRunReport {
  const holdings: Record<string, string> = {};
  for (const [asset, amount] of Object.entries(report.finalState.holdings)) {
    holdings[asset] = serializeFixed(amount as FixedPointDecimal);
  }

  return {
    version: report.version,
    scenario: {
      startTimestamp: report.scenario.startTimestamp,
      endTimestamp: report.scenario.endTimestamp,
      assets: [...report.scenario.assets],
      engineVersion: report.scenario.engineVersion,
    },
    riskMetrics: {
      maxDrawdown: serializeFixed(report.riskMetrics.maxDrawdown),
      sharpeProxy: serializeFixed(report.riskMetrics.sharpeProxy),
      volatility: serializeFixed(report.riskMetrics.volatility),
    },
    eventCounts: { ...report.eventCounts },
    finalState: {
      timestamp: report.finalState.timestamp,
      holdings,
      totalValue: serializeFixed(report.finalState.totalValue),
    },
  };
}

// Thrown when the stored version is not one this library understands.
export class UnknownReportVersionError extends Error {
  readonly storedVersion: number;
  readonly supportedVersion: number;

  constructor(storedVersion: number, supportedVersion: number) {
    super(
      `Unsupported run-report version ${storedVersion}. ` +
        `This library understands version ${supportedVersion}. ` +
        `Upgrade @meridian/strategies to read this report.`
    );
    this.name = "UnknownReportVersionError";
    this.storedVersion = storedVersion;
    this.supportedVersion = supportedVersion;
  }
}

export function isUnknownReportVersionError(
  error: unknown
): error is UnknownReportVersionError {
  return error instanceof UnknownReportVersionError;
}

export function deserializeReport(raw: SerializedRunReport): RunReport {
  if (raw.version !== REPORT_FORMAT_VERSION) {
    throw new UnknownReportVersionError(raw.version, REPORT_FORMAT_VERSION);
  }

  const holdings: Record<string, FixedPointDecimal> = {};
  for (const [asset, stroopStr] of Object.entries(raw.finalState.holdings)) {
    holdings[asset] = deserializeFixed(stroopStr);
  }

  return {
    version: REPORT_FORMAT_VERSION,
    scenario: {
      startTimestamp: raw.scenario.startTimestamp,
      endTimestamp: raw.scenario.endTimestamp,
      assets: raw.scenario.assets as AssetSymbol[],
      engineVersion: raw.scenario.engineVersion,
    },
    riskMetrics: {
      maxDrawdown: deserializeFixed(raw.riskMetrics.maxDrawdown),
      sharpeProxy: deserializeFixed(raw.riskMetrics.sharpeProxy),
      volatility: deserializeFixed(raw.riskMetrics.volatility),
    },
    eventCounts: { ...raw.eventCounts },
    finalState: {
      timestamp: raw.finalState.timestamp,
      holdings: holdings as Record<AssetSymbol, FixedPointDecimal>,
      totalValue: deserializeFixed(raw.finalState.totalValue),
    },
  };
}

// ─── JSON helpers ─────────────────────────────────────────────────────────────
// Convenience wrappers so callers can round-trip through a plain JSON string.

export function reportToJSON(report: RunReport): string {
  return JSON.stringify(serializeReport(report));
}

export function reportFromJSON(json: string): RunReport {
  const raw = JSON.parse(json) as SerializedRunReport;
  return deserializeReport(raw);
}

// ─── Warm-start ──────────────────────────────────────────────────────────────

// Options that control how a warm-started run merges with its saved report.
export interface WarmStartOptions {
  // The end of the new window.  Must be strictly after report.finalState.timestamp.
  newEndTimestamp: SimulationTimestamp;
  // If supplied, event counts from the continuation are merged (summed) with
  // the base report's counts. If omitted, the returned report's eventCounts
  // are those of the continuation segment alone.
  mergeEventCounts?: boolean;
}

// The input handed to the continuation run. Callers use this to resume from
// exactly where the saved report left off.
export interface WarmStartContext {
  // The portfolio state the continuation run should use as its starting point.
  readonly startingState: PortfolioState;
  // The scenario for the continuation window.
  readonly scenario: RunScenario;
}

// Build a WarmStartContext from a saved report and the desired new end time.
export function buildWarmStartContext(
  report: RunReport,
  options: WarmStartOptions
): WarmStartContext {
  const { newEndTimestamp } = options;
  if (newEndTimestamp <= report.finalState.timestamp) {
    throw new RangeError(
      `newEndTimestamp (${newEndTimestamp}) must be strictly after the ` +
        `report's final timestamp (${report.finalState.timestamp})`
    );
  }

  return {
    startingState: report.finalState,
    scenario: {
      startTimestamp: report.finalState.timestamp,
      endTimestamp: newEndTimestamp,
      assets: report.scenario.assets,
      engineVersion: report.scenario.engineVersion,
    },
  };
}

// Merge a continuation RunReport back into the base report to produce a single
// unified report spanning the full window.
export function mergeReports(
  base: RunReport,
  continuation: RunReport,
  options: WarmStartOptions
): RunReport {
  if (continuation.scenario.startTimestamp !== base.finalState.timestamp) {
    throw new RangeError(
      `Continuation start (${continuation.scenario.startTimestamp}) does not ` +
        `match base final timestamp (${base.finalState.timestamp})`
    );
  }

  const mergeEventCounts = options.mergeEventCounts ?? true;

  const eventCounts: EventCounts = mergeEventCounts
    ? {
        rebalances:
          base.eventCounts.rebalances + continuation.eventCounts.rebalances,
        deposits: base.eventCounts.deposits + continuation.eventCounts.deposits,
        withdrawals:
          base.eventCounts.withdrawals + continuation.eventCounts.withdrawals,
        priceFeedMisses:
          base.eventCounts.priceFeedMisses +
          continuation.eventCounts.priceFeedMisses,
      }
    : continuation.eventCounts;

  // For merged risk metrics we take the worst of the two drawdowns and the
  // continuation's volatility / sharpeProxy, since the continuation reflects
  // the most recent regime. Callers that need a mathematically combined
  // metric should recompute from raw timeseries; this merge is best-effort.
  const maxDrawdown =
    base.riskMetrics.maxDrawdown.compareTo(
      continuation.riskMetrics.maxDrawdown
    ) >= 0
      ? base.riskMetrics.maxDrawdown
      : continuation.riskMetrics.maxDrawdown;

  return {
    version: REPORT_FORMAT_VERSION,
    scenario: {
      startTimestamp: base.scenario.startTimestamp,
      endTimestamp: continuation.scenario.endTimestamp,
      assets: base.scenario.assets,
      engineVersion: base.scenario.engineVersion,
    },
    riskMetrics: {
      maxDrawdown,
      sharpeProxy: continuation.riskMetrics.sharpeProxy,
      volatility: continuation.riskMetrics.volatility,
    },
    eventCounts,
    finalState: continuation.finalState,
  };
}
