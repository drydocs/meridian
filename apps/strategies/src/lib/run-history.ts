import {
  Decimal,
  FixedPointDecimal,
  KNOWN_ASSETS,
  ScenarioSchema,
  maxDrawdown,
  sharpeRatio,
  valueAtRisk,
} from "@meridian/strategies";
import type {
  AssetSymbol,
  BacktestResult,
  BacktestSnapshot,
  Position,
  Scenario,
} from "@meridian/strategies";

export const RUN_HISTORY_STORAGE_KEY = "meridian:run-history:v1";
export const RUN_HISTORY_VERSION = 1 as const;
/** Keep the 50 most recent completed runs in local storage. */
export const RUN_HISTORY_LIMIT = 50;

export interface RunRiskMetrics {
  readonly maxDrawdown: Decimal;
  readonly sharpeRatio: Decimal | null;
  readonly valueAtRisk: Decimal | null;
}

export interface RunRecord {
  readonly version: typeof RUN_HISTORY_VERSION;
  readonly id: string;
  readonly createdAt: number;
  readonly scenario: Scenario;
  readonly result: BacktestResult;
  readonly riskMetrics: RunRiskMetrics;
}

export interface RunHistoryLoadResult {
  readonly records: readonly RunRecord[];
  readonly droppedCount: number;
}

export interface RunHistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function createRunRecord(
  scenario: Scenario,
  result: BacktestResult,
  options: { readonly id?: string; readonly createdAt?: number } = {}
): RunRecord {
  return {
    version: RUN_HISTORY_VERSION,
    id: options.id ?? crypto.randomUUID(),
    createdAt: options.createdAt ?? Date.now(),
    scenario: ScenarioSchema.parse(scenario),
    result,
    riskMetrics: computeRunRiskMetrics(result),
  };
}

export function loadRunHistory(
  storage: RunHistoryStorage = browserStorage()
): RunHistoryLoadResult {
  const serialized = storage.getItem(RUN_HISTORY_STORAGE_KEY);
  if (serialized === null) return { records: [], droppedCount: 0 };

  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { records: [], droppedCount: 1 };
    }
    throw error;
  }

  if (!isObject(raw) || raw.version !== RUN_HISTORY_VERSION) {
    return { records: [], droppedCount: 1 };
  }
  if (!Array.isArray(raw.records)) {
    return { records: [], droppedCount: 1 };
  }

  const records: RunRecord[] = [];
  let droppedCount = 0;
  for (const candidate of raw.records) {
    const record = parseRunRecord(candidate);
    if (record === null) {
      droppedCount += 1;
    } else {
      records.push(record);
    }
  }
  return { records: records.slice(0, RUN_HISTORY_LIMIT), droppedCount };
}

export function saveRunRecord(
  record: RunRecord,
  storage: RunHistoryStorage = browserStorage()
): readonly RunRecord[] {
  const { records } = loadRunHistory(storage);
  const updated = [
    record,
    ...records.filter((existing) => existing.id !== record.id),
  ].slice(0, RUN_HISTORY_LIMIT);
  storage.setItem(
    RUN_HISTORY_STORAGE_KEY,
    JSON.stringify({
      version: RUN_HISTORY_VERSION,
      records: updated.map(serializeRunRecord),
    })
  );
  return updated;
}

export function deleteRunRecord(
  id: string,
  storage: RunHistoryStorage = browserStorage()
): RunHistoryLoadResult {
  const history = loadRunHistory(storage);
  const records = history.records.filter((record) => record.id !== id);
  writeRunHistory(records, storage);
  return { records, droppedCount: history.droppedCount };
}

export function clearRunHistory(
  storage: RunHistoryStorage = browserStorage()
): void {
  storage.removeItem(RUN_HISTORY_STORAGE_KEY);
}

function computeRunRiskMetrics(result: BacktestResult): RunRiskMetrics {
  const values = result.snapshots.map((snapshot) =>
    Decimal.fromString(snapshot.value.toString(), 18)
  );
  let peak: Decimal | null = null;
  const drawdowns: Decimal[] = [];
  const returns: Decimal[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined) continue;
    if (peak === null || value.gt(peak)) peak = value;
    if (peak.isPositive()) {
      drawdowns.push(value.div(peak).sub(Decimal.one(18)));
    }

    const previous = values[index - 1];
    if (previous?.isPositive()) {
      returns.push(value.div(previous).sub(Decimal.one(18)));
    }
  }

  const firstReturn = returns[0];
  const hasReturnVariance =
    firstReturn !== undefined &&
    returns.some((value) => !value.eq(firstReturn));
  return {
    maxDrawdown: maxDrawdown(drawdowns),
    sharpeRatio:
      returns.length >= 2 && hasReturnVariance ? sharpeRatio(returns) : null,
    valueAtRisk: returns.length > 0 ? valueAtRisk(returns, 0.95) : null,
  };
}

function serializeRunRecord(record: RunRecord): SerializedRunRecord {
  return {
    version: record.version,
    id: record.id,
    createdAt: record.createdAt,
    scenario: record.scenario,
    result: {
      strategyName: record.result.strategyName,
      initialCash: record.result.initialCash.toString(),
      snapshots: record.result.snapshots.map((snapshot) => ({
        index: snapshot.index,
        timestamp: snapshot.timestamp,
        cash: snapshot.cash.toString(),
        positions: snapshot.positions.map((position) => ({
          asset: position.asset,
          ...(position.memberId === undefined
            ? {}
            : { memberId: position.memberId }),
          size: position.size.toString(),
          basis: position.basis.toString(),
        })),
        value: snapshot.value.toString(),
      })),
      finalValue: record.result.finalValue.toString(),
      strategyEquity: record.result.strategyEquity.toString(),
      totalInterest: record.result.totalInterest.toString(),
      totalFunding: record.result.totalFunding.toString(),
      totalFees: record.result.totalFees.toString(),
    },
    riskMetrics: {
      maxDrawdown: record.riskMetrics.maxDrawdown.toString(),
      sharpeRatio: record.riskMetrics.sharpeRatio?.toString() ?? null,
      valueAtRisk: record.riskMetrics.valueAtRisk?.toString() ?? null,
    },
  };
}

interface SerializedRunRecord {
  readonly version: number;
  readonly id: string;
  readonly createdAt: number;
  readonly scenario: Scenario;
  readonly result: {
    readonly strategyName: string;
    readonly initialCash: string;
    readonly snapshots: readonly {
      readonly index: number;
      readonly timestamp: number;
      readonly cash: string;
      readonly positions: readonly {
        readonly asset: string;
        readonly memberId?: string;
        readonly size: string;
        readonly basis: string;
      }[];
      readonly value: string;
    }[];
    readonly finalValue: string;
    readonly strategyEquity: string;
    readonly totalInterest: string;
    readonly totalFunding: string;
    readonly totalFees: string;
  };
  readonly riskMetrics: {
    readonly maxDrawdown: string;
    readonly sharpeRatio: string | null;
    readonly valueAtRisk: string | null;
  };
}

function parseRunRecord(raw: unknown): RunRecord | null {
  if (
    !isObject(raw) ||
    raw.version !== RUN_HISTORY_VERSION ||
    !isNonEmptyString(raw.id) ||
    !isValidDateTimestamp(raw.createdAt) ||
    !isObject(raw.result) ||
    !isObject(raw.riskMetrics)
  ) {
    return null;
  }

  const scenario = ScenarioSchema.safeParse(raw.scenario);
  if (!scenario.success) return null;
  const result = parseBacktestResult(raw.result);
  const maxDrawdownValue = parseDecimal(raw.riskMetrics.maxDrawdown);
  const sharpeRatioValue = parseNullableDecimal(raw.riskMetrics.sharpeRatio);
  const valueAtRiskValue = parseNullableDecimal(raw.riskMetrics.valueAtRisk);
  if (
    result === null ||
    maxDrawdownValue === null ||
    sharpeRatioValue === undefined ||
    valueAtRiskValue === undefined
  ) {
    return null;
  }

  return {
    version: RUN_HISTORY_VERSION,
    id: raw.id,
    createdAt: raw.createdAt,
    scenario: scenario.data,
    result,
    riskMetrics: {
      maxDrawdown: maxDrawdownValue,
      sharpeRatio: sharpeRatioValue,
      valueAtRisk: valueAtRiskValue,
    },
  };
}

function parseBacktestResult(
  raw: Record<string, unknown>
): BacktestResult | null {
  if (!isNonEmptyString(raw.strategyName) || !Array.isArray(raw.snapshots)) {
    return null;
  }
  const initialCash = parseFixedPoint(raw.initialCash);
  const finalValue = parseFixedPoint(raw.finalValue);
  const strategyEquity = parseFixedPoint(raw.strategyEquity);
  const totalInterest = parseFixedPoint(raw.totalInterest);
  const totalFunding = parseFixedPoint(raw.totalFunding);
  const totalFees = parseFixedPoint(raw.totalFees);
  if (
    initialCash === null ||
    finalValue === null ||
    strategyEquity === null ||
    totalInterest === null ||
    totalFunding === null ||
    totalFees === null
  ) {
    return null;
  }
  const snapshots: BacktestSnapshot[] = [];
  for (const rawSnapshot of raw.snapshots) {
    const snapshot = parseSnapshot(rawSnapshot);
    if (snapshot === null) return null;
    snapshots.push(snapshot);
  }
  return {
    strategyName: raw.strategyName,
    initialCash,
    snapshots,
    finalValue,
    strategyEquity,
    totalInterest,
    totalFunding,
    totalFees,
  };
}

function parseSnapshot(raw: unknown): BacktestSnapshot | null {
  if (
    !isObject(raw) ||
    !isSafeInteger(raw.index) ||
    !isSafeInteger(raw.timestamp) ||
    !Array.isArray(raw.positions)
  ) {
    return null;
  }
  const cash = parseFixedPoint(raw.cash);
  const value = parseFixedPoint(raw.value);
  if (cash === null || value === null) {
    return null;
  }
  const positions: Position[] = [];
  for (const rawPosition of raw.positions) {
    const position = parsePosition(rawPosition);
    if (position === null) return null;
    positions.push(position);
  }
  return {
    index: raw.index,
    timestamp: raw.timestamp,
    cash,
    value,
    positions,
  };
}

function parsePosition(raw: unknown): Position | null {
  if (
    !isObject(raw) ||
    !isAssetSymbol(raw.asset) ||
    (raw.memberId !== undefined && typeof raw.memberId !== "string")
  ) {
    return null;
  }
  const size = parseFixedPoint(raw.size);
  const basis = parseFixedPoint(raw.basis);
  if (size === null || basis === null) return null;
  return {
    asset: raw.asset,
    ...(typeof raw.memberId === "string" ? { memberId: raw.memberId } : {}),
    size,
    basis,
  };
}

function parseFixedPoint(raw: unknown): FixedPointDecimal | null {
  if (typeof raw !== "string" || !/^-?\d+(?:\.\d{1,7})?$/.test(raw)) {
    return null;
  }
  return FixedPointDecimal.fromString(raw);
}

function parseDecimal(raw: unknown): Decimal | null {
  if (typeof raw !== "string" || !/^-?\d+(?:\.\d{1,18})?$/.test(raw)) {
    return null;
  }
  const scale = raw.includes(".") ? raw.length - raw.indexOf(".") - 1 : 0;
  return Decimal.fromString(raw, scale);
}

function parseNullableDecimal(raw: unknown): Decimal | null | undefined {
  if (raw === null) return null;
  return parseDecimal(raw) ?? undefined;
}

function writeRunHistory(
  records: readonly RunRecord[],
  storage: RunHistoryStorage
): void {
  storage.setItem(
    RUN_HISTORY_STORAGE_KEY,
    JSON.stringify({
      version: RUN_HISTORY_VERSION,
      records: records.map(serializeRunRecord),
    })
  );
}

function browserStorage(): RunHistoryStorage {
  return window.localStorage;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isValidDateTimestamp(value: unknown): value is number {
  return isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000;
}

function isAssetSymbol(value: unknown): value is AssetSymbol {
  return (
    typeof value === "string" &&
    /^[A-Z][A-Z0-9]{1,11}$/.test(value) &&
    KNOWN_ASSETS.has(value)
  );
}
