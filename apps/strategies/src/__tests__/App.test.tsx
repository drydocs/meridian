import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { STRATEGY_ENGINE } from "@meridian/strategies";
import App from "../App";

describe("App shell", () => {
  it("renders the header and engine version", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Strategy simulations" })
    ).toBeInTheDocument();
    expect(screen.getByTestId("engine-version")).toHaveTextContent(
      `${STRATEGY_ENGINE.name} v${STRATEGY_ENGINE.version}`
    );
  });

  it("shows the simulation-only notice", () => {
    render(<App />);
    const notice = screen.getByTestId("simulation-notice");
    expect(notice).toHaveTextContent("Simulation only");
    expect(notice).toHaveTextContent(/cannot sign or submit a transaction/);
  });

  it("starts on Single Run with that tab marked current", () => {
    render(<App />);
    expect(screen.getByTestId("view-single-run")).toBeInTheDocument();
    expect(screen.getByTestId("nav-single-run")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("nav-history")).not.toHaveAttribute("aria-current");
  });

  it("navigates between all views", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("nav-history"));
    expect(screen.getByTestId("view-history")).toBeInTheDocument();
    expect(screen.queryByTestId("view-single-run")).not.toBeInTheDocument();
    expect(screen.getByTestId("nav-history")).toHaveAttribute("aria-current", "page");

    fireEvent.click(screen.getByTestId("nav-comparison"));
    expect(screen.getByTestId("view-comparison")).toBeInTheDocument();
    expect(screen.queryByTestId("view-history")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("nav-single-run"));
    expect(screen.getByTestId("view-single-run")).toBeInTheDocument();
  });

  it("exposes a labelled navigation landmark with three tabs", () => {
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Strategy views" });
    expect(nav.querySelectorAll("button")).toHaveLength(3);
  });
});
