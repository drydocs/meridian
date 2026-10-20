import { describe, expect, it } from "vitest";

import { Decimal } from "../decimal";
import {
  correlationMatrix,
  CorrelationMatrixError,
  type CorrelationEntry,
  type MemberReturnSeries,
} from "./correlation-matrix";

const series = (id: string, values: string[]): MemberReturnSeries => ({
  id,
  returns: values.map((value) => Decimal.fromString(value)),
});

const expectClose = (
  entry: CorrelationEntry,
  expected: string,
  tolerance = "0.000000000001"
): void => {
  expect(entry).toBeDefined();
  const difference = entry!.sub(Decimal.fromString(expected));
  const bound = Decimal.fromString(tolerance, 18);
  expect(difference.gt(bound) || difference.lt(bound.neg())).toBe(false);
};

const expectUnit = (entry: CorrelationEntry): void => {
  expect(entry?.eq(Decimal.one())).toBe(true);
};

describe("correlationMatrix", () => {
  it("returns a unit diagonal for a single member", () => {
    const matrix = correlationMatrix([series("a", ["1", "2", "3"])]);
    expect(matrix).toHaveLength(1);
    expectUnit(matrix[0]![0]);
  });

  it("returns an empty matrix for no members", () => {
    expect(correlationMatrix([])).toEqual([]);
  });

  it("marks a perfectly correlated pair as 1", () => {
    const matrix = correlationMatrix([
      series("a", ["1", "2", "3"]),
      series("b", ["2", "4", "6"]),
    ]);

    expectClose(matrix[0]![1], "1");
    expectClose(matrix[1]![0], "1");
    expectUnit(matrix[0]![0]);
    expectUnit(matrix[1]![1]);
  });

  it("marks a perfectly anti-correlated pair as -1", () => {
    const matrix = correlationMatrix([
      series("a", ["1", "2", "3"]),
      series("b", ["3", "2", "1"]),
    ]);

    expectClose(matrix[0]![1], "-1");
    expectClose(matrix[1]![0], "-1");
  });

  it("computes a known intermediate correlation", () => {
    const matrix = correlationMatrix([
      series("a", ["1", "2", "3"]),
      series("b", ["1", "3", "2"]),
    ]);

    expectClose(matrix[0]![1], "0.5");
    expectClose(matrix[1]![0], "0.5");
  });

  it("returns undefined, not NaN, for a zero-variance member", () => {
    const matrix = correlationMatrix([
      series("a", ["1", "2", "3"]),
      series("b", ["5", "5", "5"]),
    ]);

    expect(matrix[0]![1]).toBeUndefined();
    expect(matrix[1]![0]).toBeUndefined();
    expectUnit(matrix[1]![1]);
  });

  it("returns undefined off-diagonal for series shorter than two points", () => {
    const matrix = correlationMatrix([series("a", ["1"]), series("b", ["2"])]);

    expect(matrix[0]![1]).toBeUndefined();
    expectUnit(matrix[0]![0]);
    expectUnit(matrix[1]![1]);
  });

  it("is symmetric with a unit diagonal", () => {
    const matrix = correlationMatrix([
      series("a", ["1", "2", "3", "4"]),
      series("b", ["2", "1", "4", "3"]),
      series("c", ["1", "1", "2", "2"]),
    ]);

    for (let row = 0; row < matrix.length; row += 1) {
      expectUnit(matrix[row]![row]);
      for (let column = 0; column < matrix.length; column += 1) {
        const forward = matrix[row]![column];
        const reverse = matrix[column]![row];
        if (forward === undefined || reverse === undefined) {
          expect(forward).toBe(reverse);
        } else {
          expect(forward.toString()).toBe(reverse.toString());
        }
      }
    }
  });

  it("rejects duplicate member ids", () => {
    expect(() =>
      correlationMatrix([series("a", ["1", "2"]), series("a", ["2", "1"])])
    ).toThrowError(CorrelationMatrixError);
  });

  it("rejects mismatched series lengths", () => {
    expect(() =>
      correlationMatrix([series("a", ["1", "2"]), series("b", ["1", "2", "3"])])
    ).toThrowError(CorrelationMatrixError);
  });
});
