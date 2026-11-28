import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { HistoryView } from "../views/HistoryView";
import { ComparisonView } from "../views/ComparisonView";

// These views currently render only their empty states; no populated state
// exists yet, so only the empty paths can be asserted. SingleRunView has its
// own suite in views/SingleRunView.test.tsx.
describe.each([
  [
    "HistoryView",
    HistoryView,
    "view-history",
    "empty-history",
    "Run History",
    "No past runs recorded",
  ],
  [
    "ComparisonView",
    ComparisonView,
    "view-comparison",
    "empty-comparison",
    "Comparison",
    "No runs to compare",
  ],
])("%s", (_name, View, viewId, emptyId, title, emptyTitle) => {
  it("renders its heading and empty state", () => {
    render(<View />);
    expect(screen.getByTestId(viewId)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: title })).toBeTruthy();
    expect(screen.getByTestId(emptyId)).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 3, name: emptyTitle })
    ).toBeTruthy();
  });
});
