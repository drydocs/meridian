import { describe, it, expect } from "vitest";
import { toBigInt } from "./internal";

describe("toBigInt", () => {
  it("passes bigint values through unchanged", () => {
    expect(toBigInt(42n)).toBe(42n);
    expect(toBigInt(0n)).toBe(0n);
  });

  it("converts numbers by truncating the fractional part", () => {
    expect(toBigInt(10)).toBe(10n);
    expect(toBigInt(1.9)).toBe(1n);
  });

  it("returns 0n for null and undefined", () => {
    expect(toBigInt(null)).toBe(0n);
    expect(toBigInt(undefined)).toBe(0n);
  });

  it("throws TypeError for string values", () => {
    expect(() => toBigInt("42")).toThrow(TypeError);
    expect(() => toBigInt("42")).toThrow(/unexpected type string/);
  });

  it("throws TypeError for object and array values", () => {
    expect(() => toBigInt({})).toThrow(TypeError);
    expect(() => toBigInt([1n])).toThrow(TypeError);
  });
});
