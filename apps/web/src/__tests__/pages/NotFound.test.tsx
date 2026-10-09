import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NotFound } from "../../pages/NotFound";

describe("NotFound", () => {
  it("renders a 404 heading", () => {
    render(<NotFound />);
    expect(screen.getByText("404")).toBeDefined();
    expect(screen.getByText("Page not found")).toBeDefined();
  });

  it("links back to the dashboard and home", () => {
    render(<NotFound />);

    const dashboard = screen.getByText("Back to dashboard");
    expect(dashboard.getAttribute("href")).toBe("/app/");

    const home = screen.getByText("Home");
    expect(home.getAttribute("href")).toBe("/");
  });
});
