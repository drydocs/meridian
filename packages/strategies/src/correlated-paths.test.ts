import { describe, it, expect } from "vitest";
import {
  generateCorrelatedPaths,
  choleskyDecompose,
  NotPositiveDefiniteError,
  InvalidPathConfigError,
  FixedPointDecimal,
} from "./index";
import type { AssetPathSpec, FixedPointDecimal as FPD } from "./index";

const D = (v: string) => FixedPointDecimal.fromString(v);
const num = (d: FPD) => Number(d.toStroops()) / 1e7;
const matrix = (rows: string[][]) => rows.map((r) => r.map(D));

const specs: AssetPathSpec[] = [
  {
    asset: "USDC",
    initialPrice: D("100"),
    drift: D("0.05"),
    volatility: D("0.4"),
  },
  {
    asset: "EURC",
    initialPrice: D("50"),
    drift: D("0.02"),
    volatility: D("0.3"),
  },
];
const base = {
  assets: specs,
  correlation: matrix([
    ["1", "0.8"],
    ["0.8", "1"],
  ]),
  steps: 5000,
  dt: D("0.0027397"),
  seed: 42,
};

function logReturns(prices: FPD[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    out.push(Math.log(num(prices[i] as FPD) / num(prices[i - 1] as FPD)));
  }
  return out;
}

function sampleCorrelation(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = (a[i] as number) - ma;
    const db = (b[i] as number) - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  return cov / Math.sqrt(va * vb);
}

describe("generateCorrelatedPaths", () => {
  it("tracks the input correlation within tolerance", () => {
    const paths = generateCorrelatedPaths(base);
    const a = logReturns(paths.get("USDC") as FPD[]);
    const b = logReturns(paths.get("EURC") as FPD[]);
    expect(Math.abs(sampleCorrelation(a, b) - 0.8)).toBeLessThan(0.03);
  });

  it("tracks negative and near-zero correlation", () => {
    for (const rho of ["-0.6", "0"]) {
      const paths = generateCorrelatedPaths({
        ...base,
        correlation: matrix([
          ["1", rho],
          [rho, "1"],
        ]),
      });
      const r = sampleCorrelation(
        logReturns(paths.get("USDC") as FPD[]),
        logReturns(paths.get("EURC") as FPD[])
      );
      expect(Math.abs(r - Number(rho))).toBeLessThan(0.05);
    }
  });

  it("reproduces identical path sets from one seed and differs across seeds", () => {
    const a = generateCorrelatedPaths(base);
    const b = generateCorrelatedPaths(base);
    const c = generateCorrelatedPaths({ ...base, seed: 43 });
    const str = (p: typeof a) =>
      JSON.stringify([...p].map(([k, v]) => [k, v.map((x) => x.toString())]));
    expect(str(a)).toBe(str(b));
    expect(str(a)).not.toBe(str(c));
  });

  it("returns steps + 1 points starting at the initial price", () => {
    const paths = generateCorrelatedPaths({ ...base, steps: 10 });
    expect(paths.get("USDC")).toHaveLength(11);
    expect(paths.get("EURC")?.[0]?.toString()).toBe("50");
  });

  it("holds prices flat with zero drift and volatility", () => {
    const flat = specs.map((s) => ({
      ...s,
      drift: D("0"),
      volatility: D("0"),
    }));
    const paths = generateCorrelatedPaths({ ...base, assets: flat, steps: 5 });
    expect(paths.get("USDC")?.every((p) => p.toString() === "100")).toBe(true);
  });

  it("accepts an injected RNG", () => {
    let i = 0;
    const rng = () => (i++ * 0.37) % 1 || 0.5;
    const a = generateCorrelatedPaths({ ...base, steps: 20, rng });
    expect(a.get("USDC")).toHaveLength(21);
  });

  it("rejects a non-positive-definite matrix", () => {
    const bad = [
      matrix([
        ["1", "1.1"],
        ["1.1", "1"],
      ]),
      matrix([
        ["1", "1"],
        ["1", "1"],
      ]),
      matrix([
        ["1", "0.5"],
        ["0.4", "1"],
      ]),
      matrix([["1", "0.5"]]),
      matrix([
        ["2", "0"],
        ["0", "1"],
      ]),
    ];
    for (const correlation of bad) {
      expect(() => generateCorrelatedPaths({ ...base, correlation })).toThrow(
        NotPositiveDefiniteError
      );
    }
  });

  it("rejects invalid configuration", () => {
    expect(() => generateCorrelatedPaths({ ...base, steps: -1 })).toThrow(
      InvalidPathConfigError
    );
    expect(() => generateCorrelatedPaths({ ...base, steps: 2.5 })).toThrow(
      InvalidPathConfigError
    );
    expect(() => generateCorrelatedPaths({ ...base, dt: D("0") })).toThrow(
      InvalidPathConfigError
    );
    expect(() =>
      generateCorrelatedPaths({ ...base, assets: [], correlation: [] })
    ).toThrow(InvalidPathConfigError);
    expect(() =>
      generateCorrelatedPaths({
        ...base,
        assets: [specs[0] as AssetPathSpec, specs[0] as AssetPathSpec],
      })
    ).toThrow(InvalidPathConfigError);
    expect(() =>
      generateCorrelatedPaths({
        ...base,
        assets: [
          { ...(specs[0] as AssetPathSpec), initialPrice: D("0") },
          specs[1] as AssetPathSpec,
        ],
      })
    ).toThrow(InvalidPathConfigError);
    expect(() =>
      generateCorrelatedPaths({
        ...base,
        assets: [
          { ...(specs[0] as AssetPathSpec), volatility: D("-0.1") },
          specs[1] as AssetPathSpec,
        ],
      })
    ).toThrow(InvalidPathConfigError);
  });
});

describe("choleskyDecompose", () => {
  it("factors a known matrix", () => {
    const L = choleskyDecompose([
      [4, 2],
      [2, 5],
    ]);
    expect(L[0]).toEqual([2, 0]);
    expect(L[1]?.[0]).toBeCloseTo(1);
    expect(L[1]?.[1]).toBeCloseTo(2);
  });
});
