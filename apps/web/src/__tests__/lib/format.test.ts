import { describe, it, expect } from "vitest";
import { formatUsd } from "../../lib/format";

// Intl uses non-breaking / narrow non-breaking spaces in fr-FR output.
const normalize = (s: string) =>
  s.replace(new RegExp("[\\u00a0\\u202f]", "g"), " ");

describe("formatUsd", () => {
  it("formats a typical amount in en-US", () => {
    expect(formatUsd(1234.56, "en")).toBe("$1,234.56");
  });

  it("formats zero with two decimals", () => {
    expect(formatUsd(0, "en")).toBe("$0.00");
  });

  it("pads whole numbers to two decimals", () => {
    expect(formatUsd(5, "en")).toBe("$5.00");
  });

  it("rounds fractional values to two decimals", () => {
    expect(formatUsd(0.005, "en")).toBe("$0.01");
    expect(formatUsd(1.234, "en")).toBe("$1.23");
    expect(formatUsd(0.1 + 0.2, "en")).toBe("$0.30");
  });

  it("formats large values with grouping separators", () => {
    expect(formatUsd(1_000_000, "en")).toBe("$1,000,000.00");
    expect(formatUsd(123_456_789.99, "en")).toBe("$123,456,789.99");
  });

  it("formats negative values", () => {
    expect(formatUsd(-42.5, "en")).toBe("-$42.50");
  });

  it("uses French formatting for the fr locale", () => {
    const out = normalize(formatUsd(1234.56, "fr"));
    expect(out).toContain("1 234,56");
    expect(out).toContain("$");
  });

  it("falls back to en-US formatting for unknown locales", () => {
    expect(formatUsd(1234.56, "de")).toBe("$1,234.56");
    expect(formatUsd(1234.56, "")).toBe("$1,234.56");
  });
});
