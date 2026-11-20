import {
  Decimal,
  FixedPointDecimal,
  KNOWN_ASSET_SYMBOLS,
  MARKET_REGIMES,
  maxDrawdown,
  parseScenario,
  ScenarioValidationError,
  sharpeRatio,
  serializeSnapshots,
  valueAtRisk,
} from "@meridian/strategies";
import type {
  AssetSymbol,
  BacktestResult,
  BacktestSnapshot,
  Position,
  Scenario,
  VenuePosition,
} from "@meridian/strategies";
import type { ScenarioRun } from "./scenario-run";

/** Keep the 50 most recent completed simulation runs in browser storage. */
export const MAX_RUN_HISTORY = 50;
export const RUN_HISTORY_STORAGE_KEY = "meridian.strategies.run-history.v1";
const RUN_HISTORY_VERSION = 1;
const DECIMAL_PATTERN = /^-?\d+(?:\.\d{1,18})?$/;
const FIXED_POINT_PATTERN = /^-?\d+(?:\.\d{1,7})?$/;
const KNOWN_ASSETS = new Set<string>(KNOWN_ASSET_SYMBOLS);

export interface RunRiskMetrics {
  readonly maxDrawdown: string;
  readonly sharpeRatio: string;
  readonly valueAtRisk: string;
}

export interface RunRecord {
  readonly version: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly scenario: Scenario;
  readonly market: ScenarioRun["market"];
  readonly result: BacktestResult;
  readonly riskMetrics: RunRiskMetrics;
}

interface SerializedRunRecord {
  readonly version: number;
  readonly id: string;
  readonly createdAt: string;
  readonly scenario: unknown;
  readonly market: unknown;
  readonly result: unknown;
  readonly riskMetrics: unknown;
}

export interface LoadedRunHistory {
  readonly records: readonly RunRecord[];
  readonly dropped: boolean;
}

let fallbackId = 0;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDecimal(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_PATTERN.test(value);
}

function isFixedPoint(value: unknown): value is string {
  return typeof value === "string" && FIXED_POINT_PATTERN.test(value);
}

function isAssetSymbol(value: unknown): value is AssetSymbol {
  return typeof value === "string" && KNOWN_ASSETS.has(value);
}

function isMarket(value: unknown): value is ScenarioRun["market"] {
  return (
    isObject(value) &&
    typeof value.regime === "string" &&
    (MARKET_REGIMES as readonly string[]).includes(value.regime) &&
    isFixedPoint(value.startPrice) &&
    isFixedPoint(value.drift) &&
    isFixedPoint(value.volatility) &&
    isFixedPoint(value.cashRateAnnual)
  );
}

function hydrateSnapshots(serialized: unknown): readonly BacktestSnapshot[] {
  if (typeof serialized !== "string") {
    throw new TypeError("run snapshots must be serialized JSON");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new TypeError("run snapshots must be an array");
  }
  return parsed.map((item): BacktestSnapshot => {
    if (
      !isObject(item) ||
      typeof item.index !== "number" ||
      !Number.isInteger(item.index) ||
      typeof item.timestamp !== "number" ||
      !Number.isFinite(item.timestamp) ||
      !isFixedPoint(item.cash) ||
      !isFixedPoint(item.value) ||
      !Array.isArray(item.positions)
    ) {
      throw new TypeError("invalid run snapshot");
    }

    const positions = item.positions.map((position): Position => {
      if (
        !isObject(position) ||
        !isAssetSymbol(position.asset) ||
        !isFixedPoint(position.size) ||
        !isFixedPoint(position.basis)
      ) {
        throw new TypeError("invalid snapshot position");
      }
      return {
        asset: position.asset,
        ...(typeof position.memberId === "string"
          ? { memberId: position.memberId }
          : {}),
        size: FixedPointDecimal.fromString(position.size),
        basis: FixedPointDecimal.fromString(position.basis),
      };
    });

    let venues: VenuePosition[] | undefined;
    if (item.venues !== undefined) {
      if (!Array.isArray(item.venues)) {
        throw new TypeError("invalid snapshot venues");
      }
      venues = item.venues.map((venue): VenuePosition => {
        if (
          !isObject(venue) ||
          typeof venue.venueId !== "string" ||
          !isAssetSymbol(venue.asset) ||
          !isFixedPoint(venue.deployedPrincipal) ||
          !isFixedPoint(venue.accruedYield)
        ) {
          throw new TypeError("invalid snapshot venue");
        }
        return {
          venueId: venue.venueId,
          asset: venue.asset,
          ...(typeof venue.memberId === "string"
            ? { memberId: venue.memberId }
            : {}),
          deployedPrincipal: FixedPointDecimal.fromString(
            venue.deployedPrincipal
          ),
          accruedYield: FixedPointDecimal.fromString(venue.accruedYield),
        };
      });
    }

    return {
      index: item.index,
      timestamp: item.timestamp,
      cash: FixedPointDecimal.fromString(item.cash),
      positions,
      ...(venues && venues.length > 0 ? { venues } : {}),
      value: FixedPointDecimal.fromString(item.value),
    };
  });
}

function deserializeRecord(value: unknown): RunRecord | null {
  if (!isObject(value) || value.version !== RUN_HISTORY_VERSION) return null;
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !isObject(value.result) ||
    !isObject(value.riskMetrics) ||
    !isMarket(value.market)
  ) {
    return null;
  }

  let scenario: Scenario;
  let snapshots: readonly BacktestSnapshot[];
  try {
    scenario = parseScenario(value.scenario);
    snapshots = hydrateSnapshots(value.result.snapshots);
  } catch (error) {
    if (
      error instanceof TypeError ||
      error instanceof SyntaxError ||
      error instanceof ScenarioValidationError
    ) {
      return null;
    }
    throw error;
  }

  const result = value.result;
  const riskMetrics = value.riskMetrics;
  if (
    typeof result.strategyName !== "string" ||
    !isFixedPoint(result.initialCash) ||
    !isFixedPoint(result.finalValue) ||
    !isFixedPoint(result.strategyEquity) ||
    !isFixedPoint(result.totalInterest) ||
    !isFixedPoint(result.totalFunding) ||
    !isFixedPoint(result.totalFees) ||
    !isDecimal(riskMetrics.maxDrawdown) ||
    !isDecimal(riskMetrics.sharpeRatio) ||
    !isDecimal(riskMetrics.valueAtRisk)
  ) {
    return null;
  }

  return {
    version: RUN_HISTORY_VERSION,
    id: value.id,
    createdAt: value.createdAt,
    scenario,
    market: value.market,
    result: {
      strategyName: result.strategyName,
      initialCash: FixedPointDecimal.fromString(result.initialCash),
      snapshots,
      finalValue: FixedPointDecimal.fromString(result.finalValue),
      strategyEquity: FixedPointDecimal.fromString(result.strategyEquity),
      totalInterest: FixedPointDecimal.fromString(result.totalInterest),
      totalFunding: FixedPointDecimal.fromString(result.totalFunding),
      totalFees: FixedPointDecimal.fromString(result.totalFees),
    },
    riskMetrics: {
      maxDrawdown: riskMetrics.maxDrawdown,
      sharpeRatio: riskMetrics.sharpeRatio,
      valueAtRisk: riskMetrics.valueAtRisk,
    },
  };
}

function serializeRecord(record: RunRecord): SerializedRunRecord {
  return {
    version: RUN_HISTORY_VERSION,
    id: record.id,
    createdAt: record.createdAt,
    scenario: record.scenario,
    market: record.market,
    result: {
      strategyName: record.result.strategyName,
      initialCash: record.result.initialCash.toString(),
      snapshots: serializeSnapshots(record.result.snapshots),
      finalValue: record.result.finalValue.toString(),
      strategyEquity: record.result.strategyEquity.toString(),
      totalInterest: record.result.totalInterest.toString(),
      totalFunding: record.result.totalFunding.toString(),
      totalFees: record.result.totalFees.toString(),
    },
    riskMetrics: record.riskMetrics,
  };
}

function newestFirst(records: readonly RunRecord[]): RunRecord[] {
  return records
    .map((record, index) => ({ record, index }))
    .sort(
      (left, right) =>
        Date.parse(right.record.createdAt) -
          Date.parse(left.record.createdAt) || right.index - left.index
    )
    .map(({ record }) => record);
}

function persist(
  records: readonly RunRecord[],
  storage: Storage
): readonly RunRecord[] {
  const recent = newestFirst(records).slice(0, MAX_RUN_HISTORY);
  storage.setItem(
    RUN_HISTORY_STORAGE_KEY,
    JSON.stringify({
      version: RUN_HISTORY_VERSION,
      records: recent.map(serializeRecord),
    })
  );
  return recent;
}

export function loadRunHistory(
  storage: Storage = window.localStorage
): LoadedRunHistory {
  const stored = storage.getItem(RUN_HISTORY_STORAGE_KEY);
  if (stored === null) return { records: [], dropped: false };

  let envelope: unknown;
  try {
    envelope = JSON.parse(stored);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    storage.removeItem(RUN_HISTORY_STORAGE_KEY);
    return { records: [], dropped: true };
  }

  if (
    !isObject(envelope) ||
    envelope.version !== RUN_HISTORY_VERSION ||
    !Array.isArray(envelope.records)
  ) {
    storage.removeItem(RUN_HISTORY_STORAGE_KEY);
    return { records: [], dropped: true };
  }

  let dropped = false;
  const records: RunRecord[] = [];
  for (const candidate of envelope.records) {
    const record = deserializeRecord(candidate);
    if (record === null) {
      dropped = true;
    } else {
      records.push(record);
    }
  }
  const recent = newestFirst(records).slice(0, MAX_RUN_HISTORY);
  if (dropped || recent.length !== records.length) {
    persist(recent, storage);
  }
  return { records: recent, dropped };
}

function calculateRiskMetrics(result: BacktestResult): RunRiskMetrics {
  const scale = 18;
  const one = Decimal.one(scale);
  let peak = Decimal.fromString(result.initialCash.toString(), scale);
  const drawdowns: Decimal[] = [];
  const returns: Decimal[] = [];
  let previous = peak;

  for (const snapshot of result.snapshots) {
    const value = Decimal.fromString(snapshot.value.toString(), scale);
    if (value.gt(peak)) peak = value;
    if (peak.isPositive()) {
      drawdowns.push(value.div(peak).sub(one));
    }
    if (previous.isPositive()) {
      returns.push(value.sub(previous).div(previous));
    }
    previous = value;
  }

  let sharpe = Decimal.zero(scale);
  if (returns.length >= 2) {
    try {
      sharpe = sharpeRatio(returns);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  }
  return {
    maxDrawdown: maxDrawdown(drawdowns).toString(),
    sharpeRatio: sharpe.toString(),
    valueAtRisk:
      returns.length > 0 ? valueAtRisk(returns, 0.95).toString() : "0",
  };
}

function makeId(createdAt: string): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  fallbackId += 1;
  return `run-${Date.parse(createdAt)}-${fallbackId}`;
}

export function createRunRecord(
  run: ScenarioRun,
  createdAt = new Date()
): RunRecord {
  const timestamp = createdAt.toISOString();
  return {
    version: RUN_HISTORY_VERSION,
    id: makeId(timestamp),
    createdAt: timestamp,
    scenario: run.scenario,
    market: run.market,
    result: run.result,
    riskMetrics: calculateRiskMetrics(run.result),
  };
}

export function saveRunHistory(
  records: readonly RunRecord[],
  storage: Storage = window.localStorage
): readonly RunRecord[] {
  return persist(records, storage);
}

export function deleteRunHistoryRecord(
  records: readonly RunRecord[],
  id: string,
  storage: Storage = window.localStorage
): readonly RunRecord[] {
  return persist(
    records.filter((record) => record.id !== id),
    storage
  );
}

export function clearRunHistory(storage: Storage = window.localStorage): void {
  storage.removeItem(RUN_HISTORY_STORAGE_KEY);
}

export function toScenarioRun(record: RunRecord): ScenarioRun {
  return {
    scenario: record.scenario,
    market: record.market,
    result: record.result,
  };
}
