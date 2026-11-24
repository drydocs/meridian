import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { FixedPointDecimal } from "@meridian/strategies";
import { RiskMetricsPanel } from "./RiskMetricsPanel";
import type { RiskSnapshot } from "../lib/risk-series";

function snapshots(...values: string[]): RiskSnapshot[] {
  return values.map((value) => ({
    value: FixedPointDecimal.fromString(value),
  }));
}

// Returns +10%, -10%, +10%, +10%: max drawdown 10%, daily Sharpe
// sqrt(365 / 3) = 11.03, and the 5% tail is the -10% step.
const RUN = snapshots("100", "110", "99", "108.9", "119.79");

function metric(id: string) {
  return within(screen.getByTestId(`risk-metric-${id}`));
}

describe("RiskMetricsPanel", () => {
  it("shows each metric for a completed run", () => {
    render(<RiskMetricsPanel snapshots={RUN} step="P1D" />);

    expect(screen.getByTestId("risk-metric-max-drawdown-value")).toHaveProperty(
      "textContent",
      "10.00%"
    );
    expect(screen.getByTestId("risk-metric-sharpe-value")).toHaveProperty(
      "textContent",
      "11.03"
    );
    expect(screen.getByTestId("risk-metric-var-value")).toHaveProperty(
      "textContent",
      "10.00%"
    );
    expect(screen.getByText("Value at risk (95%)")).toBeTruthy();
    expect(screen.getByText(/from 4 per-step returns/)).toBeTruthy();
  });

  it("shows the downside metrics for a completed run", () => {
    render(<RiskMetricsPanel snapshots={RUN} step="P1D" />);

    // The 5% tail is the single -10% step.
    expect(screen.getByTestId("risk-metric-cvar-value")).toHaveProperty(
      "textContent",
      "10.00%"
    );
    // Downside deviation sqrt(0.01 / 4) = 0.05, mean 0.05: sqrt(365).
    expect(screen.getByTestId("risk-metric-sortino-value")).toHaveProperty(
      "textContent",
      "19.10"
    );
    // 0.05 x 365 / 0.10.
    expect(screen.getByTestId("risk-metric-calmar-value")).toHaveProperty(
      "textContent",
      "182.50"
    );
    expect(screen.getByText("Conditional VaR (95%)")).toBeTruthy();
    expect(metric("cvar").getByText(/^CVaR = /)).toBeTruthy();
    expect(metric("sortino").getByText(/^Sortino = /)).toBeTruthy();
    expect(metric("calmar").getByText(/^Calmar = /)).toBeTruthy();
    expect(screen.getByText(/365 periods per 365-day year/)).toBeTruthy();
  });

  it("states the unit and sign convention next to each value", () => {
    render(<RiskMetricsPanel snapshots={RUN} step="P1D" />);

    expect(
      metric("max-drawdown").getByText(
        /Percent of the running peak value, quoted as a positive loss/
      )
    ).toBeTruthy();
    expect(
      metric("sharpe").getByText(/Unitless, annualized over 365 periods/)
    ).toBeTruthy();
    expect(
      metric("var").getByText(
        /Percent of value lost over one P1D step, quoted as a positive loss/
      )
    ).toBeTruthy();
    expect(
      metric("var").getByText(/worst 5% of steps was a gain/)
    ).toBeTruthy();
  });

  it("explains each metric with its formula", () => {
    render(<RiskMetricsPanel snapshots={RUN} step="P1D" />);

    expect(metric("max-drawdown").getByText(/^MDD = /)).toBeTruthy();
    expect(metric("sharpe").getByText(/^Sharpe = /)).toBeTruthy();
    expect(metric("var").getByText(/^VaR = /)).toBeTruthy();
  });

  it("uses the scenario confidence level and shows a negative VaR as a gain", () => {
    render(
      <RiskMetricsPanel snapshots={RUN} step="P1D" confidenceLevel={0.5} />
    );

    expect(screen.getByText("Value at risk (50%)")).toBeTruthy();
    expect(screen.getByTestId("risk-metric-var-value")).toHaveProperty(
      "textContent",
      "-10.00%"
    );
  });

  it("shows not enough data for every metric with no snapshots", () => {
    render(<RiskMetricsPanel snapshots={[]} step="P1D" />);

    for (const id of [
      "max-drawdown",
      "sharpe",
      "var",
      "cvar",
      "sortino",
      "calmar",
    ]) {
      expect(metric(id).getByText("Not enough data")).toBeTruthy();
    }
    expect(
      metric("max-drawdown").getByText(/no snapshots to measure a drawdown/)
    ).toBeTruthy();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it("shows not enough data for Sharpe and VaR with fewer than two returns", () => {
    render(<RiskMetricsPanel snapshots={snapshots("100", "90")} step="P1D" />);

    expect(
      metric("sharpe").getByText(/at least two per-step returns/)
    ).toBeTruthy();
    expect(
      metric("var").getByText(/at least two per-step returns/)
    ).toBeTruthy();
    expect(screen.getByTestId("risk-metric-max-drawdown-value")).toHaveProperty(
      "textContent",
      "10.00%"
    );
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it("shows not enough data for Sharpe with a zero-variance series", () => {
    render(
      <RiskMetricsPanel
        snapshots={snapshots("100", "110", "121", "133.1")}
        step="P1D"
      />
    );

    expect(
      metric("sharpe").getByText(/Every per-step return is identical/)
    ).toBeTruthy();
    expect(screen.getByTestId("risk-metric-max-drawdown-value")).toHaveProperty(
      "textContent",
      "0.00%"
    );
    expect(screen.getByTestId("risk-metric-var-value")).toHaveProperty(
      "textContent",
      "-10.00%"
    );
    expect(screen.getByTestId("risk-metric-cvar-value")).toHaveProperty(
      "textContent",
      "-10.00%"
    );
    expect(
      metric("sortino").getByText(/No per-step return fell below 0%/)
    ).toBeTruthy();
    expect(
      metric("calmar").getByText(/never fell below an earlier peak/)
    ).toBeTruthy();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it("explains inputs the engine cannot read instead of throwing", () => {
    const { rerender } = render(
      <RiskMetricsPanel snapshots={RUN} step="daily" />
    );
    expect(screen.getByTestId("risk-metrics-invalid").textContent).toMatch(
      /scenario step/
    );

    rerender(
      <RiskMetricsPanel snapshots={RUN} step="P1D" confidenceLevel={1} />
    );
    expect(screen.getByTestId("risk-metrics-invalid").textContent).toMatch(
      /confidence level/
    );

    rerender(
      <RiskMetricsPanel snapshots={snapshots("100", "0", "5")} step="P1D" />
    );
    expect(screen.getByTestId("risk-metrics-invalid").textContent).toMatch(
      /reached zero or below/
    );
  });

  it("does not mutate the run it is given", () => {
    const frozen = Object.freeze(
      RUN.map((snapshot) => Object.freeze(snapshot))
    );
    const before = frozen.map((snapshot) => snapshot.value.toString());

    render(<RiskMetricsPanel snapshots={frozen} step="P1D" />);

    expect(frozen.map((snapshot) => snapshot.value.toString())).toEqual(before);
  });
});
