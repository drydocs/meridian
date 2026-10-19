import {
  durationToMilliseconds,
  parseScenario,
  toIsoInstant,
} from "./scenario";
import type { Scenario } from "./scenario";
import type { AssetSymbol, SimulationTimestamp } from "./types";
import { FixedPointDecimal } from "./types";
import { XorShift64 } from "./rng";

// Version 2 added `generators`. A version 1 report carries no generator state,
// so it cannot resume a run that draws from the seeded generators.
export const REPORT_FORMAT_VERSION = 2 as const;
export type ReportFormatVersion = typeof REPORT_FORMAT_VERSION;

// Risk metrics summarising the run.
export interface ReportRiskMetrics {
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
export interface ReportPortfolioState {
  readonly timestamp: SimulationTimestamp;
  readonly holdings: Readonly<Record<AssetSymbol, FixedPointDecimal>>;
  // Total portfolio value denominated in the reference asset (USDC).
  readonly totalValue: FixedPointDecimal;
}

// The `XorShift64` state of each generator stream in the run, keyed by a stream
// id the run chooses (for example one per asset, or one per path index), since
// a run can draw from several generators and a single value could not say which
// one it belongs to. A run that draws from no generator stores no streams.
export type GeneratorStates = Readonly<Record<string, bigint>>;

export interface ReportGenerators {
  // Each stream's state when the run began: the seeded state for a fresh run,
  // the base report's `end` for a warm-started one.
  readonly start: GeneratorStates;
  // Each stream's state at `finalState`, which a continuation resumes from.
  readonly end: GeneratorStates;
}

// A complete, self-contained run report.
//
// `scenario` is the validated input the run was produced from, and `generators`
// the position of every seeded stream it drew from, so a run can be reproduced
// from the report and a warm-started one continues each stream where the
// previous run stopped rather than restarting it from the seed.
export interface RunReport {
  readonly version: ReportFormatVersion;
  readonly scenario: Scenario;
  // The engine that produced the run. Distinct from `scenario.strategy.version`,
  // which versions the strategy config rather than the code that ran it.
  readonly engineVersion: string;
  readonly riskMetrics: ReportRiskMetrics;
  readonly eventCounts: EventCounts;
  readonly finalState: ReportPortfolioState;
  readonly generators: ReportGenerators;
}

// ─── Wire format ─────────────────────────────────────────────────────────────
// All FixedPointDecimal values are serialised as the raw bigint stroop count
// expressed as a decimal string (e.g. "10000001"). This is lossless and safe
// across JSON serialisers that would truncate large numbers. Generator states
// are 64-bit, past what a JSON number holds exactly, so they are decimal strings
// too. The scenario needs no conversion, since every value it carries is already
// a string or a number.

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
  scenario: Scenario;
  engineVersion: string;
  riskMetrics: SerializedRiskMetrics;
  eventCounts: EventCounts;
  finalState: SerializedPortfolioState;
  generators: SerializedGenerators;
}

interface SerializedGenerators {
  start: Record<string, string>;
  end: Record<string, string>;
}

// ─── Serialization ───────────────────────────────────────────────────────────

function serializeFixed(v: FixedPointDecimal): string {
  return v.toStroops().toString();
}

function deserializeFixed(s: string): FixedPointDecimal {
  // `BigInt("")` is 0n and `BigInt("0x10")` is 16n, so a corrupted report would
  // otherwise read as a real position instead of failing. A JSON number is
  // rejected too: `RegExp.test` coerces, and `JSON.parse` has already rounded
  // the value, so it would be read one stroop off with no error.
  if (typeof s !== "string" || !/^-?\d+$/.test(s)) {
    throw new TypeError(
      `Invalid stroop value in run report: ${JSON.stringify(s)}`
    );
  }
  return FixedPointDecimal.fromStroops(BigInt(s));
}

function serializeStates(states: GeneratorStates): Record<string, string> {
  const wire: Record<string, string> = {};
  for (const [stream, state] of Object.entries(states)) {
    wire[stream] = state.toString();
  }
  return wire;
}

// Checked the way stroop values are, and then against the range a generator can
// hold, so a corrupted state fails here rather than resuming a different stream.
function deserializeStates(wire: unknown, label: string): GeneratorStates {
  if (wire === null || typeof wire !== "object" || Array.isArray(wire)) {
    throw new TypeError(
      `Invalid generator states in run report ${label}: ${JSON.stringify(wire)}`
    );
  }
  const states: Record<string, bigint> = {};
  for (const [stream, value] of Object.entries(wire as object)) {
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
      throw new TypeError(
        `Invalid generator state for stream "${stream}" in run report ` +
          `${label}: ${JSON.stringify(value)}`
      );
    }
    states[stream] = XorShift64.fromState(BigInt(value)).getState();
  }
  return states;
}

// Copied field by field so the wire object shares no nested value with the
// report it came from.
function copyScenario(scenario: Scenario): Scenario {
  return {
    schemaVersion: scenario.schemaVersion,
    window: { ...scenario.window },
    assets: [...scenario.assets],
    source: { ...scenario.source },
    startingCapital: scenario.startingCapital,
    strategy: { ...scenario.strategy, params: { ...scenario.strategy.params } },
    seed: scenario.seed,
  };
}

export function serializeReport(report: RunReport): SerializedRunReport {
  const holdings: Record<string, string> = {};
  for (const [asset, amount] of Object.entries(report.finalState.holdings)) {
    holdings[asset] = serializeFixed(amount as FixedPointDecimal);
  }

  return {
    version: report.version,
    scenario: copyScenario(report.scenario),
    engineVersion: report.engineVersion,
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
    generators: {
      start: serializeStates(report.generators.start),
      end: serializeStates(report.generators.end),
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
    // Validated rather than trusted, so a corrupted report cannot hand a caller
    // a scenario the engine would refuse at run time.
    scenario: parseScenario(raw.scenario),
    engineVersion: raw.engineVersion,
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
    generators: {
      start: deserializeStates(raw.generators?.start, "generators.start"),
      end: deserializeStates(raw.generators?.end, "generators.end"),
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

// Options for the warm-start entry points.
export interface WarmStartOptions {
  // The end of the new window. Building a context requires it to be strictly
  // after the base report's final timestamp; merging one back requires it to
  // equal the continuation's end timestamp.
  newEndTimestamp: SimulationTimestamp;
}

export interface MergeOptions extends WarmStartOptions {
  // Whether to sum the two reports' event counts. Defaults to true, since the
  // merged report spans both windows. Set false to keep the continuation's
  // counts alone.
  mergeEventCounts?: boolean;
}

// The input handed to the continuation run.
export interface WarmStartContext {
  // The portfolio state the continuation run should use as its starting point.
  readonly startingState: ReportPortfolioState;
  // The scenario for the continuation window, on its own a legal input to a run.
  readonly scenario: Scenario;
  // The state each generator stream should resume from, through
  // `XorShift64.fromState`. The continuation report records it as its
  // `generators.start`, which is what `mergeReports` checks.
  readonly generatorStates: GeneratorStates;
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

  const stepMs = durationToMilliseconds(report.scenario.window.step);
  const windowMs = newEndTimestamp - report.finalState.timestamp;
  if (windowMs % stepMs !== 0) {
    throw new RangeError(
      `The continuation window of ${windowMs} ms is not a whole number of ` +
        `steps of ${stepMs} ms, so the run's clock would reject it`
    );
  }

  return {
    startingState: report.finalState,
    // Parsed rather than assembled, so the caller gets back a scenario a run
    // will accept, including the schema's floor on the starting capital.
    scenario: parseScenario({
      ...report.scenario,
      window: {
        start: toIsoInstant(report.finalState.timestamp),
        end: toIsoInstant(newEndTimestamp),
        step: report.scenario.window.step,
      },
      startingCapital: report.finalState.totalValue.toString(),
    }),
    generatorStates: { ...report.generators.end },
  };
}

// Restores every stream in a warm-start context as a generator positioned where
// the base run stopped, keyed by the same stream ids.
export function restoreGenerators(
  context: WarmStartContext
): Record<string, XorShift64> {
  const generators: Record<string, XorShift64> = {};
  for (const [stream, state] of Object.entries(context.generatorStates)) {
    generators[stream] = XorShift64.fromState(state);
  }
  return generators;
}

// Names the first stream whose state differs between the two sets, including
// one present in only one of them, or null when they match.
function generatorStateMismatch(
  expected: GeneratorStates,
  actual: GeneratorStates
): string | null {
  for (const stream of Object.keys(expected)) {
    if (actual[stream] !== expected[stream]) return stream;
  }
  for (const stream of Object.keys(actual)) {
    if (!(stream in expected)) return stream;
  }
  return null;
}

// Asset order is part of the scenario, so a reordered set is a different one.
function sameAssets(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((asset, index) => asset === b[index]);
}

// Key order is not part of a config, so the same entries in another order are
// still the same params block.
function sameStringRecord(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>
): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => a[key] === b[key])
  );
}

// Names the first scenario field, other than the window and the starting
// capital, where the continuation disagrees with the base. A merged report
// carries a single scenario for the whole window, so a disagreement would
// otherwise be reported under the base's value.
function runConfigMismatch(
  base: Scenario,
  continuation: Scenario
): string | null {
  if (base.seed !== continuation.seed) return "seed";
  if (base.source.price !== continuation.source.price) return "source.price";
  if (base.source.rate !== continuation.source.rate) return "source.rate";
  if (base.strategy.id !== continuation.strategy.id) return "strategy.id";
  if (base.strategy.version !== continuation.strategy.version) {
    return "strategy.version";
  }
  if (!sameStringRecord(base.strategy.params, continuation.strategy.params)) {
    return "strategy.params";
  }
  if (!sameAssets(base.assets, continuation.assets)) return "assets";
  if (
    durationToMilliseconds(base.window.step) !==
    durationToMilliseconds(continuation.window.step)
  ) {
    return "window.step";
  }
  return null;
}

// Merge a continuation RunReport back into the base report to produce a single
// unified report spanning the full window.
export function mergeReports(
  base: RunReport,
  continuation: RunReport,
  options: MergeOptions
): RunReport {
  // Compared as instants rather than as strings, since the schema accepts both
  // `...T00:00:00Z` and `...T00:00:00.000Z` for the same moment.
  if (
    Date.parse(continuation.scenario.window.start) !== base.finalState.timestamp
  ) {
    throw new RangeError(
      `Continuation start (${continuation.scenario.window.start}) does not ` +
        `match base final timestamp (${base.finalState.timestamp})`
    );
  }
  // The value-side counterpart of that check. The merged report carries the
  // base's scenario, so a continuation that started from a different capital
  // would leave the report's stated capital contradicting its own final state.
  if (
    FixedPointDecimal.fromString(
      continuation.scenario.startingCapital
    ).toStroops() !== base.finalState.totalValue.toStroops()
  ) {
    throw new RangeError(
      `Continuation starting capital (${continuation.scenario.startingCapital}) ` +
        `does not match base final value (${base.finalState.totalValue.toString()})`
    );
  }
  if (
    Date.parse(continuation.scenario.window.end) !== options.newEndTimestamp
  ) {
    throw new RangeError(
      `Continuation end (${continuation.scenario.window.end}) does not ` +
        `match the requested new end timestamp (${options.newEndTimestamp})`
    );
  }
  // The merged report takes the continuation's final state as its own, so a
  // state from earlier than the continuation's own window end would leave the
  // merged report claiming coverage it holds no state for.
  if (
    continuation.finalState.timestamp !==
    Date.parse(continuation.scenario.window.end)
  ) {
    throw new RangeError(
      `Continuation final state is from ${continuation.finalState.timestamp}, ` +
        `but its window ends at ${continuation.scenario.window.end}`
    );
  }
  if (continuation.engineVersion !== base.engineVersion) {
    throw new RangeError(
      `Continuation engine version (${continuation.engineVersion}) ` +
        `does not match base engine version (${base.engineVersion})`
    );
  }
  const mismatch = runConfigMismatch(base.scenario, continuation.scenario);
  if (mismatch !== null) {
    throw new RangeError(
      `Continuation scenario differs from the base at ${mismatch}, so the ` +
        `merged report could not attribute the run to the right config`
    );
  }

  // The merged report attributes the continuation's draws to the streams the
  // base left off at, so a continuation that started any stream elsewhere (from
  // the seed, or from another path's state) would describe a run that never
  // happened.
  const stream = generatorStateMismatch(
    base.generators.end,
    continuation.generators.start
  );
  if (stream !== null) {
    throw new RangeError(
      `Continuation generator state for stream "${stream}" does not match ` +
        `the state the base run ended on`
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
    scenario: parseScenario({
      ...base.scenario,
      window: {
        start: base.scenario.window.start,
        end: continuation.scenario.window.end,
        step: base.scenario.window.step,
      },
    }),
    engineVersion: base.engineVersion,
    riskMetrics: {
      maxDrawdown,
      sharpeProxy: continuation.riskMetrics.sharpeProxy,
      volatility: continuation.riskMetrics.volatility,
    },
    eventCounts,
    finalState: continuation.finalState,
    generators: {
      start: base.generators.start,
      end: continuation.generators.end,
    },
  };
}
