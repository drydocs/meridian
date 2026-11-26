import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import App from "../../App";
import { SingleRunView } from "../../views/SingleRunView";
import { formatDecimal } from "../../lib/format";
import type { ScenarioRun } from "../../lib/scenario-run";
import { summarizeRiskMetrics } from "../../lib/risk-series";

function change(testId: string, value: string) {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

function submit() {
  fireEvent.click(screen.getByTestId("run-scenario"));
}

describe("SingleRunView", () => {
  it("renders the scenario fields and the params of the selected strategy", () => {
    render(<SingleRunView />);

    for (const field of [
      "input-regime",
      "input-windowStart",
      "input-windowEnd",
      "input-windowStep",
      "input-assets",
      "input-priceSource",
      "input-rateSource",
      "input-startingCapital",
      "input-seed",
      "input-strategyId",
      "input-strategyVersion",
    ]) {
      expect(screen.getByTestId(field)).toBeTruthy();
    }

    const strategy = screen.getByTestId(
      "input-strategyId"
    ) as HTMLSelectElement;
    expect(Array.from(strategy.options).map((option) => option.value)).toEqual([
      "buy-and-hold",
      "delta-neutral",
    ]);
    expect(screen.getByTestId("input-param-asset")).toBeTruthy();
    expect(screen.queryByTestId("input-param-targetLeverage")).toBeNull();

    change("input-strategyId", "delta-neutral");

    expect(screen.getByTestId("input-param-targetLeverage")).toBeTruthy();
    expect(screen.getByTestId("input-param-rebalanceBandBps")).toBeTruthy();
    expect(screen.getByTestId("input-param-fundingRatePerSecond")).toBeTruthy();
  });

  it("runs a valid scenario, shows the summary and hands the run off", async () => {
    const onRunComplete = vi.fn<(run: ScenarioRun) => void>();
    render(<SingleRunView onRunComplete={onRunComplete} />);

    submit();

    const summary = await screen.findByTestId("run-summary");
    expect(summary).toBeTruthy();
    expect(onRunComplete).toHaveBeenCalledTimes(1);
    const run = onRunComplete.mock.calls[0]![0];
    expect(run.scenario.strategy.id).toBe("buy-and-hold");

    expect(screen.getByTestId("summary-final-value").textContent).toBe(
      formatDecimal(run.result.finalValue.toString())
    );
    expect(screen.getByTestId("summary-total-interest").textContent).toBe(
      formatDecimal(run.result.totalInterest.toString())
    );
    expect(screen.getByTestId("summary-total-funding").textContent).toBe("0");
    expect(screen.getByTestId("summary-total-fees").textContent).toBe("0");
    expect(screen.queryByTestId("run-error")).toBeNull();
  });

  it("shows the engine's field-qualified message and does not run", async () => {
    const onRunComplete = vi.fn();
    render(<SingleRunView onRunComplete={onRunComplete} />);

    change("input-startingCapital", "0");
    submit();

    const fieldError = await screen.findByTestId("field-error-startingCapital");
    expect(fieldError.textContent).toBe(
      "startingCapital: startingCapital must be greater than zero"
    );
    expect(
      screen.getByTestId("input-startingCapital").getAttribute("aria-invalid")
    ).toBe("true");
    expect(
      screen.getByTestId("run-error").getAttribute("data-error-kind")
    ).toBe("validation");
    expect(screen.queryByTestId("run-summary")).toBeNull();
    expect(onRunComplete).not.toHaveBeenCalled();
  });

  it("reports an unknown strategy as a typed error instead of crashing", async () => {
    const onRunComplete = vi.fn();
    render(<SingleRunView onRunComplete={onRunComplete} />);

    change("input-strategyVersion", "9.9.9");
    submit();

    const error = await screen.findByTestId("run-error");
    expect(error.getAttribute("data-error-kind")).toBe("unknown-strategy");
    expect(error.textContent).toContain(
      "Unknown strategy 'buy-and-hold' version '9.9.9'"
    );
    expect(screen.getByTestId("scenario-form")).toBeTruthy();
    expect(screen.queryByTestId("run-summary")).toBeNull();
    expect(onRunComplete).not.toHaveBeenCalled();
  });

  it("shows the risk metrics for the completed run", async () => {
    const onRunComplete = vi.fn<(run: ScenarioRun) => void>();
    render(<SingleRunView onRunComplete={onRunComplete} />);

    expect(screen.queryByTestId("risk-metrics-panel")).toBeNull();

    submit();

    const panel = await screen.findByTestId("risk-metrics-panel");
    expect(panel).toBeTruthy();
    expect(screen.queryByTestId("risk-metrics-invalid")).toBeNull();

    // The panel is fed the run's own snapshots and window step.
    const run = onRunComplete.mock.calls[0]![0];
    const summary = summarizeRiskMetrics({
      snapshots: run.result.snapshots,
      step: run.scenario.window.step,
    });
    expect(summary.kind).toBe("computed");
    if (summary.kind !== "computed") return;
    expect(summary.returnCount).toBe(run.result.snapshots.length - 1);

    const drawdown = summary.maxDrawdown;
    if (drawdown.status === "ok") {
      expect(
        screen.getByTestId("risk-metric-max-drawdown-value").textContent
      ).toBe(`${drawdown.value.mul("100").toFixed(2)}%`);
    } else {
      expect(
        screen.getByTestId("risk-metric-max-drawdown-insufficient")
      ).toBeTruthy();
    }
    for (const id of ["max-drawdown", "sharpe", "var"]) {
      expect(screen.getByTestId(`risk-metric-${id}`)).toBeTruthy();
    }
  });

  it("drops the previous run when a later submission fails", async () => {
    const onRunCleared = vi.fn();
    render(<SingleRunView onRunCleared={onRunCleared} />);

    submit();
    await screen.findByTestId("run-summary");

    change("input-startingCapital", "0");
    submit();

    await screen.findByTestId("run-error");
    expect(screen.queryByTestId("run-summary")).toBeNull();
    expect(screen.queryByTestId("risk-metrics-panel")).toBeNull();
    expect(onRunCleared).toHaveBeenCalledTimes(1);

    change("input-startingCapital", "1000");
    submit();

    await screen.findByTestId("run-summary");
    expect(screen.queryByTestId("run-error")).toBeNull();
  });

  it("hides a parent-held run while an error is shown", async () => {
    const run = await (async () => {
      const onRunComplete = vi.fn<(run: ScenarioRun) => void>();
      const { unmount } = render(
        <SingleRunView onRunComplete={onRunComplete} />
      );
      submit();
      await screen.findByTestId("run-summary");
      unmount();
      return onRunComplete.mock.calls[0]![0];
    })();

    // A parent that never clears its state must still not show the stale run
    // next to the error.
    render(<SingleRunView latestRun={run} />);
    expect(screen.getByTestId("run-summary")).toBeTruthy();

    change("input-strategyVersion", "9.9.9");
    submit();

    await screen.findByTestId("run-error");
    expect(screen.queryByTestId("run-summary")).toBeNull();
  });
});

describe("App", () => {
  it("persists completed runs for history, comparison, and reopening", async () => {
    localStorage.clear();
    const firstRender = render(<App />);

    submit();
    await screen.findByTestId("run-summary");
    fireEvent.click(screen.getByTestId("nav-history"));
    expect(screen.getAllByTestId("history-run")).toHaveLength(1);

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByTestId("nav-comparison"));
    expect(screen.getByTestId("comparison-runs")).toBeTruthy();

    firstRender.unmount();
    render(<App />);
    fireEvent.click(screen.getByTestId("nav-history"));
    expect(screen.getAllByTestId("history-run")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Open run" }));
    expect(screen.getByTestId("run-summary")).toBeTruthy();
    localStorage.clear();
  });

  it("keeps the latest run across view switches without a reload", async () => {
    render(<App />);

    submit();
    await screen.findByTestId("run-summary");

    fireEvent.click(screen.getByTestId("nav-history"));
    expect(screen.queryByTestId("run-summary")).toBeNull();
    fireEvent.click(screen.getByTestId("nav-single-run"));

    expect(screen.getByTestId("run-summary")).toBeTruthy();
  });

  it("clears the held run after a failed submission, across view switches", async () => {
    render(<App />);

    submit();
    await screen.findByTestId("run-summary");

    change("input-startingCapital", "0");
    submit();
    await screen.findByTestId("run-error");
    expect(screen.queryByTestId("run-summary")).toBeNull();

    fireEvent.click(screen.getByTestId("nav-history"));
    fireEvent.click(screen.getByTestId("nav-single-run"));

    expect(screen.queryByTestId("run-summary")).toBeNull();
  });
});
