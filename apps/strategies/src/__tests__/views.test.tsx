import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { HistoryView } from "../views/HistoryView";
import { ComparisonView } from "../views/ComparisonView";

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
