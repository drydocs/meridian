import { describe, it, expect } from "vitest";
import { FixedPointDecimal } from "./types";
import { FundingCapture, FundingTermStructure } from "./funding";

describe("FundingTermStructure", () => {
  const mkPoint = (horizon: number, funding: string, basis: string): FundingCapture => ({
    horizon,
    funding: FixedPointDecimal.fromString(funding),
    basis: FixedPointDecimal.fromString(basis),
  });

  it("throws if empty", () => {
    expect(() => new FundingTermStructure([])).toThrow(
      "Term structure requires at least one point"
    );
  });

  it("throws if horizon is not an integer", () => {
    expect(() => new FundingTermStructure([mkPoint(1.5, "0", "0")])).toThrow(
      "Horizon must be an integer"
    );
  });

  it("sorts points by horizon", () => {
    const ts = new FundingTermStructure([
      mkPoint(20, "2", "2"),
      mkPoint(10, "1", "1"),
      mkPoint(30, "3", "3"),
    ]);
    const points = ts.points;
    expect(points[0].horizon).toBe(10);
    expect(points[1].horizon).toBe(20);
    expect(points[2].horizon).toBe(30);
  });

  it("returns flat if below minimum horizon", () => {
    const ts = new FundingTermStructure([
      mkPoint(10, "1", "0.5"),
      mkPoint(20, "2", "1.0"),
    ]);
    const p = ts.getExpectedCapture(5);
    expect(p.horizon).toBe(5);
    expect(p.funding.toString()).toBe("1");
    expect(p.basis.toString()).toBe("0.5");
  });

  it("returns flat if above maximum horizon", () => {
    const ts = new FundingTermStructure([
      mkPoint(10, "1", "0.5"),
      mkPoint(20, "2", "1.0"),
    ]);
    const p = ts.getExpectedCapture(25);
    expect(p.horizon).toBe(25);
    expect(p.funding.toString()).toBe("2");
    expect(p.basis.toString()).toBe("1");
  });

  it("returns exact point if horizon matches", () => {
    const ts = new FundingTermStructure([
      mkPoint(10, "1", "0.5"),
      mkPoint(20, "2", "1.0"),
    ]);
    const p = ts.getExpectedCapture(20);
    expect(p.horizon).toBe(20);
    expect(p.funding.toString()).toBe("2");
    expect(p.basis.toString()).toBe("1");
  });

  it("interpolates correctly and monotonically", () => {
    const ts = new FundingTermStructure([
      mkPoint(10, "1", "0.5"),
      mkPoint(20, "2", "1.5"),
    ]);
    const p = ts.getExpectedCapture(15);
    expect(p.horizon).toBe(15);
    expect(p.funding.toString()).toBe("1.5");
    expect(p.basis.toString()).toBe("1");
    
    const p2 = ts.getExpectedCapture(12);
    expect(p2.horizon).toBe(12);
    expect(p2.funding.toString()).toBe("1.2");
    expect(p2.basis.toString()).toBe("0.7");
  });

  it("throws if requested horizon is not an integer", () => {
    const ts = new FundingTermStructure([mkPoint(10, "1", "0.5")]);
    expect(() => ts.getExpectedCapture(10.5)).toThrow("Horizon must be an integer");
  });
  
  it("interpolates negative values correctly", () => {
    const ts = new FundingTermStructure([
      mkPoint(100, "-1", "-2"),
      mkPoint(200, "1", "2"),
    ]);
    const p = ts.getExpectedCapture(150);
    expect(p.funding.toString()).toBe("0");
    expect(p.basis.toString()).toBe("0");
    
    const p2 = ts.getExpectedCapture(125);
    expect(p2.funding.toString()).toBe("-0.5");
    expect(p2.basis.toString()).toBe("-1");
  });
});
