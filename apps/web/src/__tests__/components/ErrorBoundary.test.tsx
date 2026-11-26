import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactElement } from "react";
import { ErrorBoundary } from "../../components/ui/ErrorBoundary";
import { reportError } from "../../lib/errorReporter";

vi.mock("../../lib/errorReporter", () => ({
  reportError: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withTranslation: () => (WrappedComponent: any) => {
    function Wrapped(props: Record<string, unknown>) {
      return <WrappedComponent {...props} t={(key: string) => key} />;
    }
    return Wrapped;
  },
}));

function Bomb(): never {
  throw new Error("render panic");
}

describe("ErrorBoundary", () => {
  it("renders children normally when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>fine</p>
      </ErrorBoundary>
    );
    expect(screen.getByText("fine")).toBeDefined();
  });

  it("catches a render error and shows a fallback with retry, home, and reload actions", () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    render(
      <ErrorBoundary showHome>
        <Bomb />
      </ErrorBoundary>
    );

    expect(screen.getByText("errorBoundary.title")).toBeDefined();
    expect(screen.getByText("errorBoundary.reload")).toBeDefined();
    expect(screen.getByText("errorBoundary.retry")).toBeDefined();
    expect(screen.getByText("errorBoundary.home")).toBeDefined();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "render panic" }),
      expect.objectContaining({ category: "render" })
    );

    consoleErrorSpy.mockRestore();
  });

  it("re-renders the children after the retry action resets the boundary", () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    let shouldThrow = true;
    function ToggleBomb(): ReactElement {
      if (shouldThrow) {
        throw new Error("render panic");
      }
      return <p>recovered</p>;
    }
    const onReset = vi.fn(() => {
      shouldThrow = false;
    });

    render(
      <ErrorBoundary onReset={onReset}>
        <ToggleBomb />
      </ErrorBoundary>
    );

    expect(screen.getByText("errorBoundary.title")).toBeDefined();
    fireEvent.click(screen.getByText("errorBoundary.retry"));

    expect(onReset).toHaveBeenCalled();
    expect(screen.getByText("recovered")).toBeDefined();

    consoleErrorSpy.mockRestore();
  });
});
