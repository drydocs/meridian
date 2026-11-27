import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  PositionPnlCard,
  computePositionPnl,
} from "../../components/dashboard/PositionPnlCard";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

describe("PositionPnlCard", () => {
  it("shows zero yield without an error for a fresh position", () => {
    render(
      <PositionPnlCard
        position={{
          vaultId: "meridian-usdc",
          shares: 100,
          deposited: 100,
          earned: 0,
          principal: 100,
          entryTime: 1_700_000_000,
        }}
      />
    );

    expect(screen.getByTestId("position-pnl-card")).toBeDefined();
    expect(screen.getByTestId("pnl-principal").textContent).toBe("$100.00");
    expect(screen.getByTestId("pnl-gross-yield").textContent).toBe("$0.00");
    expect(screen.getByTestId("pnl-performance-fee").textContent).toBe("$0.00");
    expect(screen.getByTestId("pnl-net-yield").textContent).toBe("$0.00");
    expect(screen.getByTestId("pnl-current-value").textContent).toBe("$100.00");
  });

  it("shows principal, gross yield, 10% performance fee, net yield, and current value for an earning position", () => {
    render(
      <PositionPnlCard
        position={{
          vaultId: "meridian-usdc",
          shares: 100,
          deposited: 110,
          earned: 10,
          principal: 100,
          entryTime: 1_700_000_000,
        }}
      />
    );

    expect(screen.getByTestId("pnl-principal").textContent).toBe("$100.00");
    expect(screen.getByTestId("pnl-gross-yield").textContent).toBe("+$10.00");
    expect(screen.getByTestId("pnl-performance-fee").textContent).toBe(
      "-$1.00"
    );
    expect(screen.getByTestId("pnl-net-yield").textContent).toBe("+$9.00");
    expect(screen.getByTestId("pnl-current-value").textContent).toBe("$110.00");
  });

  it("shows a negative yield clearly with zero performance fee for a loss", () => {
    render(
      <PositionPnlCard
        position={{
          vaultId: "meridian-usdc",
          shares: 100,
          deposited: 95,
          earned: 0,
          principal: 100,
          entryTime: 1_700_000_000,
        }}
      />
    );

    expect(screen.getByTestId("pnl-principal").textContent).toBe("$100.00");
    expect(screen.getByTestId("pnl-gross-yield").textContent).toBe("-$5.00");
    expect(screen.getByTestId("pnl-gross-yield").className).toContain(
      "text-rose-400"
    );
    expect(screen.getByTestId("pnl-performance-fee").textContent).toBe("$0.00");
    expect(screen.getByTestId("pnl-net-yield").textContent).toBe("-$5.00");
    expect(screen.getByTestId("pnl-net-yield").className).toContain(
      "text-rose-400"
    );
    expect(screen.getByTestId("pnl-current-value").textContent).toBe("$95.00");
  });

  it("shows an unavailable state when a read fails and triggers retry", () => {
    const onRetry = vi.fn();
    render(<PositionPnlCard isError onRetry={onRetry} />);

    expect(screen.getByTestId("position-pnl-unavailable")).toBeDefined();
    expect(screen.getByText("positionPnl.unavailable")).toBeDefined();

    fireEvent.click(screen.getByText("common.retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("falls back to deposited minus earned when principal is omitted", () => {
    const breakdown = computePositionPnl({
      vaultId: "meridian-usdc",
      shares: 50,
      deposited: 105,
      earned: 5,
      entryTime: 1_700_000_000,
    });

    expect(breakdown.principal).toBe(100);
    expect(breakdown.grossYield).toBe(5);
    expect(breakdown.performanceFee).toBe(0.5);
    expect(breakdown.netYield).toBe(4.5);
    expect(breakdown.currentValue).toBe(105);
  });
});
