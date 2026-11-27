import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FixedPointDecimal, buildRegimeScenario } from "@meridian/strategies";
import type { BacktestSnapshot } from "@meridian/strategies";
import { HistoryView } from "../../views/HistoryView";
import { createRunRecord } from "../../lib/run-history";
import type { RunRecord } from "../../lib/run-history";
import type { ScenarioRun } from "../../lib/scenario-run";

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

function renderView(
  records: readonly RunRecord[],
  overrides: Partial<Parameters<typeof HistoryView>[0]> = {}
) {
  const props = {
    records,
    droppedRecords: false,
    selectedRunIds: new Set<string>(),
    onOpenRun: vi.fn(),
    onDeleteRun: vi.fn(),
    onClearHistory: vi.fn(),
    onToggleComparison: vi.fn(),
    ...overrides,
  };
  render(<HistoryView {...props} />);
  return props;
}

describe("HistoryView", () => {
  it("shows the empty state when there are no saved runs", () => {
    renderView([]);

    expect(screen.getByTestId("empty-history")).toBeTruthy();
    expect(screen.queryByTestId("history-run")).toBeNull();
    expect(screen.queryByTestId("clear-history")).toBeNull();
  });

  it("lists each saved run with its count", () => {
    const first = makeRecord("110", "2025-01-03T00:00:00.000Z");
    const second = makeRecord("120", "2025-01-04T00:00:00.000Z");
    renderView([second, first]);

    expect(screen.getAllByTestId("history-run")).toHaveLength(2);
    expect(screen.getByText("2 saved runs")).toBeTruthy();
  });

  it("opens a run", () => {
    const record = makeRecord("110", "2025-01-03T00:00:00.000Z");
    const props = renderView([record]);

    fireEvent.click(screen.getByTestId(`open-run-${record.id}`));

    expect(props.onOpenRun).toHaveBeenCalledWith(record);
  });

  it("toggles a run for comparison and reflects the selection", () => {
    const first = makeRecord("110", "2025-01-03T00:00:00.000Z");
    const second = makeRecord("120", "2025-01-04T00:00:00.000Z");
    const props = renderView([second, first], {
      selectedRunIds: new Set([first.id]),
    });

    const firstBox = screen.getByTestId(
      `compare-run-${first.id}`
    ) as HTMLInputElement;
    const secondBox = screen.getByTestId(
      `compare-run-${second.id}`
    ) as HTMLInputElement;
    expect(firstBox.checked).toBe(true);
    expect(secondBox.checked).toBe(false);

    fireEvent.click(secondBox);

    expect(props.onToggleComparison).toHaveBeenCalledWith(second.id);
  });

  it("deletes a single run", () => {
    const record = makeRecord("110", "2025-01-03T00:00:00.000Z");
    const props = renderView([record]);

    fireEvent.click(screen.getByTestId(`delete-run-${record.id}`));

    expect(props.onDeleteRun).toHaveBeenCalledWith(record.id);
  });

  it("clears the whole history", () => {
    const props = renderView([makeRecord("110", "2025-01-03T00:00:00.000Z")]);

    fireEvent.click(screen.getByTestId("clear-history"));

    expect(props.onClearHistory).toHaveBeenCalledTimes(1);
  });

  it("tells the user when saved runs were skipped", () => {
    renderView([makeRecord("110", "2025-01-03T00:00:00.000Z")], {
      droppedRecords: true,
    });

    expect(screen.getByTestId("history-notice").textContent).toContain(
      "could not be read"
    );
  });
});
