import { describe, expect, it } from "vitest";
import { formatDecimal } from "../../lib/format";

describe("formatDecimal", () => {
  it("groups the integer part and keeps every fractional digit", () => {
    expect(formatDecimal("0")).toBe("0");
    expect(formatDecimal("999")).toBe("999");
    expect(formatDecimal("10123.0226797")).toBe("10,123.0226797");
    expect(formatDecimal("1234567")).toBe("1,234,567");
    expect(formatDecimal("-1234.5")).toBe("-1,234.5");
  });
});
