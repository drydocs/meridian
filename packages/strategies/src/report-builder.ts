import type { BacktestResult, BacktestSnapshot } from "./backtest/runner";
import { Decimal } from "./decimal";
import { REPORT_FORMAT_VERSION } from "./report";
import type {
  EventCounts,
  GeneratorStates,
  ReportGenerators,
  ReportPortfolioState,
  ReportRiskMetrics,
  RunReport,
} from "./report";
import { decimalSqrt } from "./risk-metrics";
import { XorShift64 } from "./rng";
import { parseScenario } from "./scenario";
import type { Scenario } from "./scenario";
import { FixedPointDecimal } from "./types";
import type { AssetSymbol } from "./types";

const METRICS_SCALE = 18;
const ZERO_FIXED = FixedPointDecimal.fromStroops(0n);

/** Default engine version recorded in built reports, matching STRATEGY_ENGINE.version. */
export const DEFAULT_REPORT_ENGINE_VERSION = "0.1.0";

/**
 * Thrown when a required generator stream is absent from the start or end
 * generator states supplied to `buildRunReport`.
 */
export class MissingGeneratorStreamError extends Error {
  readonly stream: string;
  readonly location: "start" | "end";

  constructor(stream: string, location: "start" | "end") {
    super(
      `Missing generator stream "${stream}" in ${location} generator states`
    );
    this.name = "MissingGeneratorStreamError";
    this.stream = stream;
    this.location = location;
  }
}

export function isMissingGeneratorStreamError(
  error: unknown
): error is MissingGeneratorStreamError {
  return error instanceof MissingGeneratorStreamError;
}

/**
 * Either raw 64-bit generator states or live `XorShift64` instances from which
 * the current state can be read without advancing the stream.
 */
export type GeneratorStateSource =
  | GeneratorStates
  | Readonly<Record<string, XorShift64>>;

export interface BuildRunReportInput {
  /** The scenario that was executed. Validated via `parseScenario`. */
  readonly scenario: Scenario;
  /** The execution result produced by `runBacktest`. */
  readonly result: BacktestResult;
  /** Generator states captured at the start and end of the run. */
  readonly generators: {
    readonly start: GeneratorStateSource;
    readonly end: GeneratorStateSource;
  };
  /**
   * Optional list of stream IDs that must be present in both `start` and `end`.
   * Throws `MissingGeneratorStreamError` if any listed stream is absent.
   */
  readonly requiredStreams?: readonly string[];
  /**
   * Discrete event counts observed during the run. Omitted fields default to 0,
   * except `rebalances`, which is derived from snapshot position changes when
   * omitted.
   */
  readonly eventCounts?: Partial<EventCounts>;
  /**
   * Engine version string for provenance. Defaults to
   * `DEFAULT_REPORT_ENGINE_VERSION`.
   */
  readonly engineVersion?: string;
  /**
   * Reference/quote asset symbol for cash holdings in `finalState.holdings`.
   * Defaults to `"USDC"`.
   */
  readonly quoteAsset?: AssetSymbol;
  /**
   * Per-period risk-free rate subtracted from mean return when computing
   * `riskMetrics.sharpeProxy`. Defaults to 0.
   */
  readonly riskFreePerPeriod?: FixedPointDecimal;
}

/**
 * Snapshots the current 64-bit state of each `XorShift64` generator without
 * advancing any stream.
 */
export function captureGeneratorStates(
  generators: Readonly<Record<string, XorShift64>>
): GeneratorStates {
  const states: Record<string, bigint> = {};
  for (const [stream, generator] of Object.entries(generators)) {
    states[stream] = generator.getState();
  }
  return states;
}

function readGeneratorStates(source: GeneratorStateSource): GeneratorStates {
  const states: Record<string, bigint> = {};
  for (const [stream, value] of Object.entries(source)) {
    const rawState = value instanceof XorShift64 ? value.getState() : value;
    states[stream] = XorShift64.fromState(rawState).getState();
  }
  return states;
}

function resolveGenerators(
  startSource: GeneratorStateSource,
  endSource: GeneratorStateSource,
  requiredStreams?: readonly string[]
): ReportGenerators {
  const start = readGeneratorStates(startSource);
  const end = readGeneratorStates(endSource);

  if (requiredStreams !== undefined) {
    for (const stream of requiredStreams) {
      if (!(stream in start)) {
        throw new MissingGeneratorStreamError(stream, "start");
      }
      if (!(stream in end)) {
        throw new MissingGeneratorStreamError(stream, "end");
      }
    }
  }

  for (const stream of Object.keys(start)) {
    if (!(stream in end)) {
      throw new MissingGeneratorStreamError(stream, "end");
    }
  }
  for (const stream of Object.keys(end)) {
    if (!(stream in start)) {
      throw new MissingGeneratorStreamError(stream, "start");
    }
  }

  return { start, end };
}

function fixedToDecimal(value: FixedPointDecimal): Decimal {
  return new Decimal(value.toStroops(), 7).rescale(METRICS_SCALE);
}

function decimalToFixed(value: Decimal): FixedPointDecimal {
  return FixedPointDecimal.fromStroops(value.toStroops());
}

/**
 * Computes `ReportRiskMetrics` from a backtest's snapshot equity curve.
 */
export function computeReportRiskMetrics(
  snapshots: readonly BacktestSnapshot[],
  riskFreePerPeriod: FixedPointDecimal = ZERO_FIXED
): ReportRiskMetrics {
  if (snapshots.length === 0) {
    return {
      maxDrawdown: ZERO_FIXED,
      sharpeProxy: ZERO_FIXED,
      volatility: ZERO_FIXED,
    };
  }

  const zero = Decimal.zero(METRICS_SCALE);
  let peak = zero;
  let maxDd = zero;

  const returns: Decimal[] = [];
  let prevValue: Decimal | null = null;

  for (const snapshot of snapshots) {
    const value = fixedToDecimal(snapshot.value);

    if (value.gt(peak)) {
      peak = value;
    }
    if (peak.isPositive()) {
      const dd = peak.sub(value).div(peak);
      if (dd.gt(maxDd)) {
        maxDd = dd;
      }
    }

    if (prevValue !== null && prevValue.isPositive()) {
      returns.push(value.sub(prevValue).div(prevValue));
    }
    prevValue = value;
  }

  let sharpeProxy = ZERO_FIXED;
  let volatility = ZERO_FIXED;

  if (returns.length > 0) {
    let sum = zero;
    for (const r of returns) {
      sum = sum.add(r);
    }
    const count = Decimal.fromBigInt(BigInt(returns.length), 0);
    const meanReturn = sum.div(count);
    const excessMean = meanReturn.sub(fixedToDecimal(riskFreePerPeriod));
    sharpeProxy = decimalToFixed(excessMean);

    if (returns.length >= 2) {
      let sumSq = zero;
      for (const r of returns) {
        const diff = r.sub(meanReturn);
        sumSq = sumSq.add(diff.mul(diff));
      }
      const variance = sumSq.div(count);
      volatility = decimalToFixed(decimalSqrt(variance));
    }
  }

  return {
    maxDrawdown: decimalToFixed(maxDd),
    sharpeProxy,
    volatility,
  };
}

function snapshotPositionSignature(snapshot: BacktestSnapshot): string {
  const positions = snapshot.positions
    .map((p) => `${p.memberId ?? ""}:${p.asset}:${p.size.toStroops()}`)
    .sort()
    .join("|");
  const venues = (snapshot.venues ?? [])
    .map(
      (v) =>
        `${v.memberId ?? ""}:${v.venueId}:${v.asset}:${v.deployedPrincipal.toStroops()}`
    )
    .sort()
    .join("|");
  return `${positions}#${venues}`;
}

function deriveRebalanceCount(snapshots: readonly BacktestSnapshot[]): number {
  let count = 0;
  let prevSignature = "#";
  for (const snapshot of snapshots) {
    const signature = snapshotPositionSignature(snapshot);
    if (signature !== prevSignature) {
      count += 1;
      prevSignature = signature;
    }
  }
  return count;
}

function buildFinalState(
  scenario: Scenario,
  result: BacktestResult,
  quoteAsset: AssetSymbol
): ReportPortfolioState {
  const lastSnapshot =
    result.snapshots.length > 0
      ? result.snapshots[result.snapshots.length - 1]
      : undefined;

  const timestamp =
    lastSnapshot !== undefined
      ? lastSnapshot.timestamp
      : Date.parse(scenario.window.end);

  const holdings: Partial<Record<AssetSymbol, FixedPointDecimal>> = {};

  const addHolding = (asset: AssetSymbol, amount: FixedPointDecimal): void => {
    const existing = holdings[asset];
    holdings[asset] = existing === undefined ? amount : existing.add(amount);
  };

  if (lastSnapshot !== undefined) {
    addHolding(quoteAsset, lastSnapshot.cash);
    for (const position of lastSnapshot.positions) {
      addHolding(position.asset, position.size);
    }
    for (const venue of lastSnapshot.venues ?? []) {
      addHolding(venue.asset, venue.deployedPrincipal.add(venue.accruedYield));
    }
  } else {
    addHolding(quoteAsset, result.initialCash);
  }

  return {
    timestamp,
    holdings,
    totalValue: result.finalValue,
  };
}

/**
 * Builds a complete, self-contained `RunReport` from an executed scenario,
 * its `BacktestResult`, and the generator states captured at start and end.
 */
export function buildRunReport(input: BuildRunReportInput): RunReport {
  const scenario = parseScenario(input.scenario);
  const engineVersion = input.engineVersion ?? DEFAULT_REPORT_ENGINE_VERSION;
  const quoteAsset = input.quoteAsset ?? "USDC";

  const generators = resolveGenerators(
    input.generators.start,
    input.generators.end,
    input.requiredStreams
  );

  const riskMetrics = computeReportRiskMetrics(
    input.result.snapshots,
    input.riskFreePerPeriod
  );

  const eventCounts: EventCounts = {
    rebalances:
      input.eventCounts?.rebalances ??
      deriveRebalanceCount(input.result.snapshots),
    deposits: input.eventCounts?.deposits ?? 0,
    withdrawals: input.eventCounts?.withdrawals ?? 0,
    priceFeedMisses: input.eventCounts?.priceFeedMisses ?? 0,
  };

  const finalState = buildFinalState(scenario, input.result, quoteAsset);

  return {
    version: REPORT_FORMAT_VERSION,
    scenario,
    engineVersion,
    riskMetrics,
    eventCounts,
    finalState,
    generators,
  };
}
