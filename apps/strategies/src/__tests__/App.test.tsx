import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { STRATEGY_ENGINE } from "@meridian/strategies";
import App from "../App";

describe("App shell", () => {
  it("renders the header and engine version", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Strategy simulations" })
    ).toBeTruthy();
    expect(screen.getByTestId("engine-version").textContent).toContain(
      `${STRATEGY_ENGINE.name} v${STRATEGY_ENGINE.version}`
    );
  });

  it("shows the simulation-only notice", () => {
    render(<App />);
    const notice = screen.getByTestId("simulation-notice");
    expect(notice.textContent).toContain("Simulation only");
    expect(notice.textContent).toMatch(/cannot sign or submit a transaction/);
  });

  it("starts on Single Run with that tab marked current", () => {
    render(<App />);
    expect(screen.getByTestId("view-single-run")).toBeTruthy();
    expect(
      screen.getByTestId("nav-single-run").getAttribute("aria-current")
    ).toBe("page");
    expect(screen.getByTestId("nav-history").hasAttribute("aria-current")).toBe(
      false
    );
  });

  it("navigates between all views", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("nav-history"));
    expect(screen.getByTestId("view-history")).toBeTruthy();
    expect(screen.queryByTestId("view-single-run")).toBeNull();
    expect(screen.getByTestId("nav-history").getAttribute("aria-current")).toBe(
      "page"
    );

    fireEvent.click(screen.getByTestId("nav-comparison"));
    expect(screen.getByTestId("view-comparison")).toBeTruthy();
    expect(screen.queryByTestId("view-history")).toBeNull();

    fireEvent.click(screen.getByTestId("nav-single-run"));
    expect(screen.getByTestId("view-single-run")).toBeTruthy();
  });

  it("exposes a labelled navigation landmark with three tabs", () => {
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Strategy views" });
    expect(nav.querySelectorAll("button")).toHaveLength(3);
  });
});
