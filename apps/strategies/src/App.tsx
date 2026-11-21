import { useState } from "react";
import { STRATEGY_ENGINE } from "@meridian/strategies";
import { SingleRunView } from "./views/SingleRunView";
import type { ScenarioRun } from "./lib/scenario-run";
import { HistoryView } from "./views/HistoryView";
import { ComparisonView } from "./views/ComparisonView";
import {
  clearRunHistory,
  createRunRecord,
  deleteRunHistoryRecord,
  loadRunHistory,
  saveRunHistory,
  toScenarioRun,
} from "./lib/run-history";
import type { RunRecord } from "./lib/run-history";

export type StrategyView = "single-run" | "history" | "comparison";

interface NavItem {
  readonly id: StrategyView;
  readonly label: string;
}

const NAV_ITEMS: readonly NavItem[] = [
  { id: "single-run", label: "Single Run" },
  { id: "history", label: "Run History" },
  { id: "comparison", label: "Comparison" },
];

export default function App() {
  const [activeView, setActiveView] = useState<StrategyView>("single-run");
  // Held here rather than in the view so the result and risk views can read
  // the latest run without a reload, and it survives switching tabs.
  const [latestRun, setLatestRun] = useState<ScenarioRun | null>(null);
  const [history, setHistory] = useState(loadRunHistory);
  const [selectedRunIds, setSelectedRunIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );

  const handleRunComplete = (run: ScenarioRun) => {
    setLatestRun(run);
    const record = createRunRecord(run);
    setHistory({
      records: saveRunHistory([record, ...history.records]),
      dropped: history.dropped,
    });
  };

  const handleDeleteRun = (id: string) => {
    setHistory({
      records: deleteRunHistoryRecord(history.records, id),
      dropped: history.dropped,
    });
    setSelectedRunIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };

  const handleClearHistory = () => {
    clearRunHistory();
    setHistory({ ...history, records: [] });
    setSelectedRunIds(new Set());
  };

  const handleOpenRun = (record: RunRecord) => {
    setLatestRun(toScenarioRun(record));
    setActiveView("single-run");
  };

  return (
    <div className="shell">
      <header className="shell__header">
        <div className="shell__header-main">
          <div className="shell__brand">
            <svg
              viewBox="4 4 32 17"
              width="32"
              height="17"
              fill="none"
              aria-hidden="true"
              className="shell__logo"
            >
              <defs>
                <linearGradient
                  id="mg-brand-mark"
                  x1="34"
                  y1="20"
                  x2="17"
                  y2="17"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop offset="0%" stopColor="#3b82f6" />
                  <stop offset="100%" stopColor="#10b981" />
                </linearGradient>
              </defs>
              <path
                d="M34 20 A14 14 0 0 0 6 20 A11 11 0 0 1 28 20 A8 8 0 0 0 12 20 A5 5 0 0 1 22 20"
                stroke="url(#mg-brand-mark)"
                strokeWidth="2.25"
              />
              <circle cx="17" cy="17.3" r="2.6" fill="url(#mg-brand-mark)" />
            </svg>
            <div className="shell__titles">
              <span className="shell__eyebrow">Meridian</span>
              <h1 className="shell__title">Strategy simulations</h1>
            </div>
          </div>
          <div className="shell__engine" data-testid="engine-version">
            <span className="shell__engine-label">Engine:</span>{" "}
            <span className="shell__engine-value">
              {STRATEGY_ENGINE.name} v{STRATEGY_ENGINE.version}
            </span>
          </div>
        </div>

        <aside
          className="shell__notice"
          role="status"
          data-testid="simulation-notice"
          aria-label="Simulation notice"
        >
          <span className="shell__notice-tag">Simulation only</span>
          <p className="shell__notice-body">
            This application runs simulations only and cannot sign or submit a
            transaction. No live vault funds or signer connections are used.
          </p>
        </aside>

        <nav className="shell__nav" aria-label="Strategy views">
          {NAV_ITEMS.map((item) => {
            const isActive = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={`shell__nav-tab ${isActive ? "shell__nav-tab--active" : ""}`}
                onClick={() => setActiveView(item.id)}
                aria-current={isActive ? "page" : undefined}
                data-testid={`nav-${item.id}`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>
      </header>

      <main className="shell__content">
        {activeView === "single-run" && (
          <SingleRunView
            latestRun={latestRun}
            onRunComplete={handleRunComplete}
            onRunCleared={() => setLatestRun(null)}
          />
        )}
        {activeView === "history" && (
          <HistoryView
            records={history.records}
            droppedRecords={history.dropped}
            selectedRunIds={selectedRunIds}
            onOpenRun={handleOpenRun}
            onDeleteRun={handleDeleteRun}
            onClearHistory={handleClearHistory}
            onToggleComparison={(id) =>
              setSelectedRunIds((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
          />
        )}
        {activeView === "comparison" && (
          <ComparisonView
            records={history.records.filter((record) =>
              selectedRunIds.has(record.id)
            )}
          />
        )}
      </main>
    </div>
  );
}
