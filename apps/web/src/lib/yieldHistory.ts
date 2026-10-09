import type { PositionSnapshot } from "./api";

export interface YieldChartPoint {
  timestamp: number;
  total: number;
  earned: number;
  /** Value per protocol id, e.g. { blend: 12.3 }. Missing protocols are 0. */
  [protocol: string]: number;
}

/**
 * Flattens snapshots into one row per capture time with a value column per
 * protocol (recharts stacks columns, it does not group rows). Returns the
 * protocols seen, in first-seen order, so series colors stay stable.
 */
export function toChartData(snapshots: PositionSnapshot[]): {
  points: YieldChartPoint[];
  protocols: string[];
} {
  const protocols: string[] = [];
  const sorted = [...snapshots].sort((a, b) => a.timestamp - b.timestamp);
  for (const snap of sorted) {
    for (const vault of snap.vaults) {
      if (!protocols.includes(vault.protocol)) protocols.push(vault.protocol);
    }
  }
  const points = sorted.map((snap) => {
    const point: YieldChartPoint = {
      timestamp: snap.timestamp,
      total: snap.totalValue,
      earned: snap.totalEarned,
    };
    for (const protocol of protocols) point[protocol] = 0;
    for (const vault of snap.vaults) {
      point[vault.protocol] = (point[vault.protocol] ?? 0) + vault.value;
    }
    return point;
  });
  return { points, protocols };
}
