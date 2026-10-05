import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { YieldHistoryChart } from "../../components/dashboard/YieldHistoryChart";
import { usePositionHistory } from "../../hooks/usePositionHistory";

const refetch = vi.fn();

vi.mock("../../hooks/usePositionHistory", () => ({
  usePositionHistory: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

// jsdom has no layout, so ResponsiveContainer renders nothing. Stub recharts
// with elements that expose what the component handed to it.
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AreaChart: ({
    data,
    children,
  }: {
    data: unknown[];
    children: React.ReactNode;
  }) => (
    <div data-testid="area-chart" data-points={data.length}>
      {children}
    </div>
  ),
  Area: ({ dataKey }: { dataKey: string }) => (
    <div data-testid={`area-${dataKey}`} />
  ),
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
}));

const SNAPSHOTS = [
  {
    timestamp: 1_700_000_000_000,
    totalValue: 100,
    totalEarned: 0,
    vaults: [
      { vaultId: "blend-usdc-fixed", protocol: "blend", value: 100, earned: 0 },
    ],
  },
  {
    timestamp: 1_700_086_400_000,
    totalValue: 107.5,
    totalEarned: 2.5,
    vaults: [
      { vaultId: "blend-usdc-fixed", protocol: "blend", value: 60, earned: 1 },
      {
        vaultId: "defindex-usdc",
        protocol: "defindex",
        value: 47.5,
        earned: 1.5,
      },
    ],
  },
];

function mock(overrides: Partial<ReturnType<typeof usePositionHistory>>) {
  vi.mocked(usePositionHistory).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    refetch,
    ...overrides,
  } as ReturnType<typeof usePositionHistory>);
}

beforeEach(() => vi.clearAllMocks());

describe("YieldHistoryChart", () => {
  it("shows a skeleton while loading", () => {
    mock({ isLoading: true });
    render(<YieldHistoryChart publicKey="GKEY" />);
    expect(screen.getByTestId("yield-history-loading")).toBeDefined();
  });

  it("shows an error with a retry button when the fetch fails", () => {
    mock({ isError: true });
    render(<YieldHistoryChart publicKey="GKEY" />);
    expect(screen.getByText("yieldHistory.loadError")).toBeDefined();
    fireEvent.click(screen.getByText("common.retry"));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state when there are no snapshots", () => {
    mock({ data: [] });
    render(<YieldHistoryChart publicKey="GKEY" />);
    expect(screen.getByTestId("yield-history-empty")).toBeDefined();
    expect(screen.queryByTestId("yield-history-chart")).toBeNull();
  });

  it("shows the empty state for a single snapshot, which draws no line", () => {
    mock({ data: [SNAPSHOTS[0]!] });
    render(<YieldHistoryChart publicKey="GKEY" />);
    expect(screen.getByTestId("yield-history-empty")).toBeDefined();
  });

  it("renders one stacked series per protocol with cumulative earned", () => {
    mock({ data: SNAPSHOTS });
    render(<YieldHistoryChart publicKey="GKEY" />);
    expect(screen.getByTestId("area-chart").getAttribute("data-points")).toBe(
      "2"
    );
    expect(screen.getByTestId("area-blend")).toBeDefined();
    expect(screen.getByTestId("area-defindex")).toBeDefined();
    expect(screen.getByTestId("yield-history-earned").textContent).toContain(
      "+$2.50"
    );
    expect(screen.getByText("Blend Capital")).toBeDefined();
    expect(screen.getByText("DeFindex")).toBeDefined();
  });

  it("requests 30 days by default and switches range on click", () => {
    mock({ data: SNAPSHOTS });
    render(<YieldHistoryChart publicKey="GKEY" />);
    expect(usePositionHistory).toHaveBeenLastCalledWith("GKEY", 30);

    fireEvent.click(screen.getByText("yieldHistory.range7"));
    expect(usePositionHistory).toHaveBeenLastCalledWith("GKEY", 7);
    expect(
      screen.getByText("yieldHistory.range7").getAttribute("aria-pressed")
    ).toBe("true");

    fireEvent.click(screen.getByText("yieldHistory.range90"));
    expect(usePositionHistory).toHaveBeenLastCalledWith("GKEY", 90);
  });
});
