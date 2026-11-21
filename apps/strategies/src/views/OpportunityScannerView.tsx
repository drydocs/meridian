import { useMemo, useState } from "react";

/**
 * Opportunity scanner (#scanner).
 *
 * Runs a deterministic matrix of built-in strategies across synthetic market
 * regimes and ranks the cells by a documented risk-adjusted score. The scan is
 * fully local: no live data is fetched and no signing path is reachable.
 *
 * Ranking: score = return / maxDrawdown. When maxDrawdown is zero the score is
 * defined as return * 1e6 (a large sentinel) so zero-drawdown cells rank above
 * drawdown cells with equal return. Ties break on final value (descending), then
 * on strategy id (ascending, lexicographic). The same matrix and seed always
 * yield the same ranking.
 */

export const SCANNER_REGIMES = ["trending", "ranging", "high-funding"] as const;
export type ScannerRegime = (typeof SCANNER_REGIMES)[number];

export interface ScannerStrategy {
  readonly id: string;
  readonly label: string;
}

export const SCANNER_STRATEGIES: readonly ScannerStrategy[] = [
  { id: "delta-neutral", label: "Delta neutral" },
  { id: "buy-and-hold", label: "Buy and hold" },
];

export interface ScanInputs {
  readonly strategyId: string;
  readonly regime: ScannerRegime;
  readonly seed: string;
  readonly steps: number;
}

export interface CellMetrics {
  readonly finalValue: number;
  readonly pnl: number;
  readonly returnPct: number;
  readonly maxDrawdown: number;
  readonly sharpe: number;
  readonly valueAtRisk: number;
  readonly fees: number;
}

export interface ScanCell extends ScanInputs, CellMetrics {
  readonly score: number;
}

export interface ScanFilters {
  readonly regime?: ScannerRegime | "all";
  readonly strategyId?: string | "all";
  readonly minSteps?: number;
}

/** Deterministic 32-bit FNV-1a hash of a string, used to derive per-cell seeds. */
function hashSeed(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Small seeded PRNG (mulberry32) producing values in [0, 1). */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REGIME_PARAMS: Record<ScannerRegime, { drift: number; volatility: number }> = {
  trending: { drift: 0.0015, volatility: 0.004 },
  ranging: { drift: 0, volatility: 0.006 },
  "high-funding": { drift: 0.0001, volatility: 0.002 },
};

const REGIME_CARRY: Record<ScannerRegime, number> = {
  trending: 0.0002,
  ranging: 0.0001,
  "high-funding": 0.0008,
};

/**
 * Runs one matrix cell. Pure and deterministic: the same inputs always produce
 * the same metrics. A deterministic synthetic price path stands in for the
 * engine's regime feed.
 */
export function runScanCell(inputs: ScanInputs, capital = 10000): ScanCell {
  const params = REGIME_PARAMS[inputs.regime];
  const rand = makeRandom(hashSeed(`${inputs.seed}|${inputs.strategyId}|${inputs.regime}`));
  const isHedged = inputs.strategyId === "delta-neutral";
  const carry = isHedged ? REGIME_CARRY[inputs.regime] : 0;
  const feeRate = isHedged ? 0.001 : 0.0005;

  let value = capital;
  let peak = capital;
  let fees = 0;
  let worstDrawdown = 0;
  const returns: number[] = [];

  for (let step = 0; step < inputs.steps; step += 1) {
    const shock = (rand() - 0.5) * 2 * params.volatility;
    const priceMove = params.drift + shock;
    const exposure = isHedged ? 0.1 * (1 - Math.abs(shock) * 10) : 1;
    const stepReturn = exposure * priceMove + carry;
    const fee = value * feeRate * Math.abs(shock) * 10;
    fees += fee;
    const prev = value;
    value = value * (1 + stepReturn) - fee;
    returns.push(prev === 0 ? 0 : (value - prev) / prev);
    peak = Math.max(peak, value);
    const drawdown = peak === 0 ? 0 : (value - peak) / peak;
    worstDrawdown = Math.min(worstDrawdown, drawdown);
  }

  const pnl = value - capital;
  const returnPct = capital === 0 ? 0 : pnl / capital;
  const maxDrawdown = -worstDrawdown;
  const mean = returns.reduce((sum, r) => sum + r, 0) / Math.max(returns.length, 1);
  const variance =
    returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / Math.max(returns.length, 1);
  const stdev = Math.sqrt(variance);
  const sharpe = stdev === 0 ? 0 : (mean / stdev) * Math.sqrt(365);
  const sorted = [...returns].sort((a, b) => a - b);
  const varIndex = Math.min(
    Math.max(Math.ceil(0.05 * sorted.length) - 1, 0),
    Math.max(sorted.length - 1, 0),
  );
  const valueAtRisk = sorted.length === 0 ? 0 : -(sorted[varIndex] ?? 0) * capital;

  const score =
    maxDrawdown === 0 ? returnPct * 1_000_000 : returnPct / maxDrawdown;

  return {
    ...inputs,
    finalValue: value,
    pnl,
    returnPct,
    maxDrawdown,
    sharpe,
    valueAtRisk,
    fees,
    score,
  };
}

/** Builds the full matrix of strategy x regime cells for a seed and length. */
export function buildMatrix(seed: string, steps: number): ScanInputs[] {
  const cells: ScanInputs[] = [];
  for (const strategy of SCANNER_STRATEGIES) {
    for (const regime of SCANNER_REGIMES) {
      cells.push({ strategyId: strategy.id, regime, seed, steps });
    }
  }
  return cells;
}

/**
 * Ranks cells by score descending, tie-broken by final value descending, then
 * strategy id ascending, then regime ascending. Returns a new array.
 */
export function rankCells(cells: readonly ScanCell[]): ScanCell[] {
  return [...cells].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.finalValue !== a.finalValue) return b.finalValue - a.finalValue;
    if (a.strategyId !== b.strategyId) return a.strategyId < b.strategyId ? -1 : 1;
    if (a.regime !== b.regime) return a.regime < b.regime ? -1 : 1;
    return 0;
  });
}

/** Applies filters to the matrix inputs. Filters never alter run results. */
export function filterInputs(
  inputs: readonly ScanInputs[],
  filters: ScanFilters,
): ScanInputs[] {
  return inputs.filter((cell) => {
    if (filters.regime && filters.regime !== "all" && cell.regime !== filters.regime) {
      return false;
    }
    if (filters.strategyId && filters.strategyId !== "all" && cell.strategyId !== filters.strategyId) {
      return false;
    }
    if (filters.minSteps !== undefined && cell.steps < filters.minSteps) {
      return false;
    }
    return true;
  });
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatMoney(value: number): string {
  return value.toFixed(2);
}

export function OpportunityScannerView() {
  const [seed, setSeed] = useState("932");
  const [steps, setSteps] = useState(24);
  const [regimeFilter, setRegimeFilter] = useState<ScannerRegime | "all">("all");
  const [strategyFilter, setStrategyFilter] = useState<string | "all">("all");
  const [minSteps, setMinSteps] = useState(1);

  const ranked = useMemo(() => {
    const inputs = filterInputs(buildMatrix(seed, steps), {
      regime: regimeFilter,
      strategyId: strategyFilter,
      minSteps,
    });
    return rankCells(inputs.map((input) => runScanCell(input)));
  }, [seed, steps, regimeFilter, strategyFilter, minSteps]);

  return (
    <div className="view" data-testid="view-scanner">
      <div className="view__header">
        <h2 className="view__title">Opportunity scanner</h2>
        <p className="view__description">
          Runs each built-in strategy across the synthetic market regimes and ranks
          the results by return divided by maximum drawdown. Ties break on final
          value, then strategy id. The scan is deterministic for a given seed.
        </p>
      </div>

      <div className="view__controls">
        <label>
          Seed
          <input
            type="text"
            value={seed}
            onChange={(event) => setSeed(event.target.value)}
            data-testid="scanner-seed"
          />
        </label>
        <label>
          Run length (steps)
          <input
            type="number"
            min={1}
            value={steps}
            onChange={(event) => setSteps(Math.max(1, Number(event.target.value) || 1))}
            data-testid="scanner-steps"
          />
        </label>
        <label>
          Minimum run length
          <input
            type="number"
            min={1}
            value={minSteps}
            onChange={(event) => setMinSteps(Math.max(1, Number(event.target.value) || 1))}
            data-testid="scanner-min-steps"
          />
        </label>
        <label>
          Regime
          <select
            value={regimeFilter}
            onChange={(event) =>
              setRegimeFilter(event.target.value as ScannerRegime | "all")
            }
            data-testid="scanner-regime"
          >
            <option value="all">All regimes</option>
            {SCANNER_REGIMES.map((regime) => (
              <option key={regime} value={regime}>
                {regime}
              </option>
            ))}
          </select>
        </label>
        <label>
          Strategy
          <select
            value={strategyFilter}
            onChange={(event) => setStrategyFilter(event.target.value)}
            data-testid="scanner-strategy"
          >
            <option value="all">All strategies</option>
            {SCANNER_STRATEGIES.map((strategy) => (
              <option key={strategy.id} value={strategy.id}>
                {strategy.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {ranked.length === 0 ? (
        <div className="empty-state" data-testid="scanner-empty">
          <h3 className="empty-state__title">No matrix cells match</h3>
          <p className="empty-state__body">
            Adjust the regime, strategy, or minimum run length filters to include
            at least one strategy and regime combination.
          </p>
        </div>
      ) : (
        <table className="scanner-table" data-testid="scanner-table">
          <thead>
            <tr>
              <th scope="col">Rank</th>
              <th scope="col">Strategy</th>
              <th scope="col">Regime</th>
              <th scope="col">Score</th>
              <th scope="col">Final value</th>
              <th scope="col">PnL</th>
              <th scope="col">Return</th>
              <th scope="col">Max drawdown</th>
              <th scope="col">Sharpe</th>
              <th scope="col">VaR (95%)</th>
              <th scope="col">Fees</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((cell, index) => (
              <tr
                key={`${cell.strategyId}:${cell.regime}`}
                data-testid="scanner-row"
              >
                <td>{index + 1}</td>
                <td>{cell.strategyId}</td>
                <td>{cell.regime}</td>
                <td title="return / max drawdown">{cell.score.toFixed(4)}</td>
                <td>{formatMoney(cell.finalValue)}</td>
                <td>{formatMoney(cell.pnl)}</td>
                <td>{formatPct(cell.returnPct)}</td>
                <td>{formatPct(cell.maxDrawdown)}</td>
                <td>{cell.sharpe.toFixed(2)}</td>
                <td>{formatMoney(cell.valueAtRisk)}</td>
                <td>{formatMoney(cell.fees)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
