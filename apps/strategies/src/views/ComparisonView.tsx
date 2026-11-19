import { useMemo, useState } from "react";
import {
  COMPARISON_METRICS,
  buildComparison,
  type RunRecord,
} from "../lib/comparison";

interface ComparisonViewProps {
  /** Completed runs sourced from the run history store. */
  readonly runs?: readonly RunRecord[];
}

export function ComparisonView({ runs = [] }: ComparisonViewProps) {
  const [selected, setSelected] = useState<readonly string[]>([]);

  const selectedRuns = useMemo(
    () => runs.filter((run) => selected.includes(run.id)),
    [runs, selected]
  );
  const model = useMemo(() => buildComparison(selectedRuns), [selectedRuns]);

  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id]
    );

  return (
    <div className="view" data-testid="view-comparison">
      <div className="view__header">
        <h2 className="view__title">Comparison</h2>
        <p className="view__description">
          Compare multiple simulation runs side-by-side to evaluate strategy
          variants and market regimes.
        </p>
      </div>

      {runs.length > 0 && (
        <fieldset className="comparison__selector">
          <legend>Completed runs</legend>
          {runs.map((run) => (
            <label key={run.id}>
              <input
                type="checkbox"
                checked={selected.includes(run.id)}
                onChange={() => toggle(run.id)}
              />
              {run.strategyId} · {run.regime ?? "no regime"} · {run.id}
            </label>
          ))}
        </fieldset>
      )}

      {selectedRuns.length < 2 ? (
        <div className="empty-state" data-testid="empty-comparison">
          <h3 className="empty-state__title">No runs to compare</h3>
          <p className="empty-state__body">
            Select two or more completed simulation runs to compare yields,
            rebalances, and risk metrics across market regimes.{" "}
            <a href="#history">Open run history</a>
          </p>
        </div>
      ) : (
        <div className="comparison__table-wrap" style={{ overflowX: "auto" }}>
          <table className="comparison__table" data-testid="comparison-table">
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Strategy</th>
                <th scope="col">Regime</th>
                <th scope="col">Window</th>
                {COMPARISON_METRICS.map((metric) => (
                  <th scope="col" key={metric.key}>
                    {metric.label}
                    {metric.better !== "none" && (
                      <span className="comparison__direction">
                        {" "}({metric.better === "higher" ? "higher is better" : "lower is better"})
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...model.groups.entries()].map(([regime, rows]) => (
                <RegimeGroup
                  key={regime ?? "__none__"}
                  regime={regime}
                  rows={rows}
                  extrema={model.extrema}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface RegimeGroupProps {
  readonly regime: string | null;
  readonly rows: ReturnType<typeof buildComparison>["rows"];
  readonly extrema: ReturnType<typeof buildComparison>["extrema"];
}

function RegimeGroup({ regime, rows, extrema }: RegimeGroupProps) {
  return (
    <>
      <tr className="comparison__group">
        <th colSpan={4 + COMPARISON_METRICS.length} scope="rowgroup">
          {regime ?? "Regime not declared"}
        </th>
      </tr>
      {rows.map((row) => (
        <tr key={row.runId}>
          <td>{row.runId}</td>
          <td>{row.strategyId}</td>
          <td>{row.regime ?? "—"}</td>
          <td>{row.window}</td>
          {COMPARISON_METRICS.map((metric) => {
            const mark = extrema[metric.key];
            const cls =
              mark.best === row.runId
                ? "comparison__best"
                : mark.worst === row.runId
                  ? "comparison__worst"
                  : undefined;
            const value = row[metric.key];
            return (
              <td key={metric.key} className={cls}>
                {typeof value === "number" ? value.toString() : value}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
