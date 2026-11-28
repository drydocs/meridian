import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FixedPointDecimal, buildRegimeScenario } from "@meridian/strategies";
import type { BacktestSnapshot } from "@meridian/strategies";
import { HistoryView } from "../views/HistoryView";
import { ComparisonView } from "../views/ComparisonView";
import { createRunRecord } from "../lib/run-history";
import type { RunRecord } from "../lib/run-history";
import type { ScenarioRun } from "../lib/scenario-run";

function makeRecord(finalValue: string, createdAt: string): RunRecord {
  const final = FixedPointDecimal.fromString(finalValue);
  const initialCash = FixedPointDecimal.fromString("100");
  const snapshots: BacktestSnapshot[] = [
    {
      index: 0,
      timestamp: Date.UTC(2025, 0, 1),
      cash: initialCash,
      positions: [],
      value: initialCash,
    },
    {
      index: 1,
      timestamp: Date.UTC(2025, 0, 2),
      cash: final,
      positions: [],
      value: final,
    },
  ];
  const run: ScenarioRun = {
    scenario: buildRegimeScenario("trending"),
    market: {
      regime: "trending",
      startPrice: "1",
      drift: "0",
      volatility: "0",
      cashRateAnnual: "0.05",
    },
    result: {
      strategyName: "buy-and-hold",
      initialCash,
      snapshots,
      finalValue: final,
      strategyEquity: final,
      totalInterest: FixedPointDecimal.fromString("0"),
      totalFunding: FixedPointDecimal.fromString("0"),
      totalFees: FixedPointDecimal.fromString("0"),
    },
  };
  return createRunRecord(run, new Date(createdAt));
}

const emptyHistoryProps = {
  records: [] as const,
  droppedRecords: false,
  selectedRunIds: new Set<string>(),
  onOpenRun: vi.fn(),
  onDeleteRun: vi.fn(),
  onClearHistory: vi.fn(),
  onToggleComparison: vi.fn(),
};

const emptyComparisonProps = {
  records: [] as const,
};

describe.each([
  [
    "HistoryView",
    HistoryView,
    "view-history",
    "empty-history",
    "Run History",
    "No past runs recorded",
    emptyHistoryProps,
  ],
  [
    "ComparisonView",
    ComparisonView,
    "view-comparison",
    "empty-comparison",
    "Comparison",
    "No runs to compare",
    emptyComparisonProps,
  ],
])("%s", (_name, View, viewId, emptyId, title, emptyTitle, props) => {
  it("renders its heading and empty state", () => {
    render(<View {...props} />);
    expect(screen.getByTestId(viewId)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: title })).toBeTruthy();
    expect(screen.getByTestId(emptyId)).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 3, name: emptyTitle })
    ).toBeTruthy();
  });
});
