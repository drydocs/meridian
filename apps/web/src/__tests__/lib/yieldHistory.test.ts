import { describe, it, expect } from "vitest";
import { toChartData } from "../../lib/yieldHistory";
import type { PositionSnapshot } from "../../lib/api";

const snap = (
  timestamp: number,
  vaults: Array<[string, number, number]>
): PositionSnapshot => ({
  timestamp,
  totalValue: vaults.reduce((s, v) => s + v[1], 0),
  totalEarned: vaults.reduce((s, v) => s + v[2], 0),
  vaults: vaults.map(([protocol, value, earned]) => ({
    vaultId: `${protocol}-vault`,
    protocol,
    value,
    earned,
  })),
});

describe("toChartData", () => {
  it("returns nothing for no snapshots", () => {
    expect(toChartData([])).toEqual({ points: [], protocols: [] });
  });

  it("sorts by time and gives each protocol a column", () => {
    const { points, protocols } = toChartData([
      snap(2, [["blend", 12, 2]]),
      snap(1, [["blend", 10, 0]]),
    ]);
    expect(protocols).toEqual(["blend"]);
    expect(points.map((p) => p.timestamp)).toEqual([1, 2]);
    expect(points[1]).toMatchObject({ blend: 12, total: 12, earned: 2 });
  });

  it("zero-fills a protocol that is absent from some snapshots", () => {
    const { points, protocols } = toChartData([
      snap(1, [["blend", 10, 0]]),
      snap(2, [
        ["blend", 5, 1],
        ["defindex", 6, 1],
      ]),
    ]);
    expect(protocols).toEqual(["blend", "defindex"]);
    expect(points[0]?.defindex).toBe(0);
    expect(points[1]).toMatchObject({ blend: 5, defindex: 6, total: 11 });
  });

  it("sums several vaults of one protocol into one column", () => {
    const { points } = toChartData([
      snap(1, [
        ["blend", 3, 0],
        ["blend", 4, 0],
      ]),
    ]);
    expect(points[0]?.blend).toBe(7);
  });
});
