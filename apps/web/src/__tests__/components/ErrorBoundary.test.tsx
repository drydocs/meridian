import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ErrorBoundary } from "../../components/ui/ErrorBoundary";

vi.mock("react-i18next", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withTranslation: () => (WrappedComponent: any) => {
    function Wrapped(props: Record<string, unknown>) {
      return <WrappedComponent {...props} t={(key: string) => key} />;
    }
    return Wrapped;
  },
}));

function Bomb({ shouldThrow = true }: { shouldThrow?: boolean }): JSX.Element {
  if (shouldThrow) {
    throw new Error("render panic");
  }
  return <p>recovered</p>;
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

    consoleErrorSpy.mockRestore();
  });

  it("allows resetting the subtree via the retry action", () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    let throwToggle = true;
    const onReset = vi.fn(() => {
      throwToggle = false;
    });

    function TestWrapper() {
      return (
        <ErrorBoundary onReset={onReset}>
          <Bomb shouldThrow={throwToggle} />
        </ErrorBoundary>
      );
    }

    const { rerender } = render(<TestWrapper />);

    expect(screen.getByText("errorBoundary.title")).toBeDefined();

    // Click retry
    fireEvent.click(screen.getByText("errorBoundary.retry"));

    expect(onReset).toHaveBeenCalled();
    rerender(<TestWrapper />);
    expect(screen.getByText("recovered")).toBeDefined();

    consoleErrorSpy.mockRestore();
  });
});
