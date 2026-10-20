import { describe, expect, it } from "vitest";

import { FixedPointDecimal } from "../types";
import {
  allocateCapital,
  CapitalAllocationError,
  type CapitalWeight,
} from "./capital-allocation";

const weight = (id: string, value: string): CapitalWeight => ({
  id,
  weight: FixedPointDecimal.fromString(value),
});

const sum = (allocations: readonly { amount: FixedPointDecimal }[]): bigint =>
  allocations.reduce(
    (total, allocation) => total + allocation.amount.toStroops(),
    0n
  );

describe("allocateCapital", () => {
  it("splits an even total without losing a stroop", () => {
    const allocations = allocateCapital(FixedPointDecimal.fromString("100"), [
      weight("a", "1"),
      weight("b", "1"),
      weight("c", "1"),
    ]);

    expect(
      allocations.map((entry) => [entry.id, entry.amount.toString()])
    ).toEqual([
      ["a", "33.3333334"],
      ["b", "33.3333333"],
      ["c", "33.3333333"],
    ]);
    expect(sum(allocations)).toBe(1_000_000_000n);
  });

  it("assigns the residual by largest remainder, not by declaration order", () => {
    const allocations = allocateCapital(FixedPointDecimal.fromString("10"), [
      weight("a", "3"),
      weight("b", "2"),
      weight("c", "1"),
    ]);

    expect(
      allocations.map((entry) => [entry.id, entry.amount.toString()])
    ).toEqual([
      ["a", "5"],
      ["b", "3.3333333"],
      ["c", "1.6666667"],
    ]);
    expect(sum(allocations)).toBe(100_000_000n);
  });

  it("is deterministic across declaration order", () => {
    const first = allocateCapital(FixedPointDecimal.fromString("7"), [
      weight("alpha", "0.2"),
      weight("beta", "0.3"),
      weight("gamma", "0.5"),
    ]);
    const second = allocateCapital(FixedPointDecimal.fromString("7"), [
      weight("gamma", "0.5"),
      weight("alpha", "0.2"),
      weight("beta", "0.3"),
    ]);

    const byId = (
      entries: readonly { id: string; amount: FixedPointDecimal }[]
    ) =>
      Object.fromEntries(
        entries.map((entry) => [entry.id, entry.amount.toString()])
      );
    expect(byId(first)).toEqual(byId(second));
    expect(sum(first)).toBe(70_000_000n);
  });

  it("handles a total smaller than the number of members", () => {
    const allocations = allocateCapital(FixedPointDecimal.fromStroops(2n), [
      weight("a", "1"),
      weight("b", "1"),
      weight("c", "1"),
    ]);

    expect(allocations.map((entry) => entry.amount.toStroops())).toEqual([
      1n,
      1n,
      0n,
    ]);
    expect(sum(allocations)).toBe(2n);
  });

  it("gives every member zero when the total is zero", () => {
    const allocations = allocateCapital(FixedPointDecimal.fromString("0"), [
      weight("a", "1"),
      weight("b", "2"),
    ]);

    expect(allocations.map((entry) => entry.amount.toStroops())).toEqual([
      0n,
      0n,
    ]);
  });

  it("rejects a negative total", () => {
    expect(() =>
      allocateCapital(FixedPointDecimal.fromString("-1"), [weight("a", "1")])
    ).toThrowError(CapitalAllocationError);
  });

  it("rejects an empty weight vector", () => {
    expect(() =>
      allocateCapital(FixedPointDecimal.fromString("1"), [])
    ).toThrowError(CapitalAllocationError);
  });

  it("rejects duplicate ids", () => {
    expect(() =>
      allocateCapital(FixedPointDecimal.fromString("1"), [
        weight("a", "1"),
        weight("a", "2"),
      ])
    ).toThrowError(CapitalAllocationError);
  });

  it("rejects negative weights", () => {
    expect(() =>
      allocateCapital(FixedPointDecimal.fromString("1"), [weight("a", "-1")])
    ).toThrowError(CapitalAllocationError);
  });

  it("rejects a weight vector with no positive entry", () => {
    expect(() =>
      allocateCapital(FixedPointDecimal.fromString("1"), [weight("a", "0")])
    ).toThrowError(CapitalAllocationError);
  });

  it("preserves the sum for uneven weights and totals", () => {
    const cases: Array<{ total: string; weights: string[] }> = [
      { total: "0.0000001", weights: ["1", "2", "3"] },
      { total: "1", weights: ["0.3333333", "0.3333333", "0.3333334"] },
      { total: "999.9999999", weights: ["7", "11", "13", "17"] },
      { total: "12345.6789012", weights: ["0.1", "0.2", "0.7"] },
    ];

    for (const testCase of cases) {
      const allocations = allocateCapital(
        FixedPointDecimal.fromString(testCase.total),
        testCase.weights.map((value, index) => weight(`m${index}`, value))
      );
      expect(sum(allocations)).toBe(
        FixedPointDecimal.fromString(testCase.total).toStroops()
      );
    }
  });
});
