import { describe, it, expect } from "vitest";
import {
  formatApy,
  formatCompactUsd,
  formatMoneyInput,
  formatNumber,
  formatUsd,
  parseMoneyInput,
} from "../../lib/format";

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

describe("parseMoneyInput", () => {
  it("keeps whole numbers canonical in English", () => {
    expect(parseMoneyInput("1234", "en")).toBe("1234");
  });

  it("canonicalizes an English decimal and grouped paste", () => {
    expect(parseMoneyInput("1,234.5678901", "en")).toBe("1234.5678901");
  });

  it("canonicalizes French comma decimals and grouped paste", () => {
    expect(parseMoneyInput("1 234,56", "fr")).toBe("1234.56");
    expect(parseMoneyInput("1.234,56", "fr")).toBe("1234.56");
  });

  it("accepts a standard dot as a French decimal separator", () => {
    expect(parseMoneyInput("1.5", "fr")).toBe("1.5");
  });

  it("rejects ambiguous, invalid, and over-precision input", () => {
    expect(parseMoneyInput("1,23", "en")).toBeNull();
    expect(parseMoneyInput("1 23,45", "fr")).toBeNull();
    expect(parseMoneyInput("1.12345678", "en")).toBeNull();
    expect(parseMoneyInput("1,", "fr")).toBeNull();
  });
});

describe("locale-aware numeric formatting", () => {
  it("formats canonical input values for the active locale", () => {
    expect(formatMoneyInput("1234.56", "en")).toBe("1234.56");
    expect(formatMoneyInput("1234.56", "fr")).toBe("1234,56");
  });

  it("formats APY, compact TVL, and share values by locale", () => {
    expect(formatApy(5.25, "fr")).toBe("5,25");
    expect(normalize(formatCompactUsd(12_300, "fr"))).toContain("12 k");
    expect(
      normalize(formatNumber(1234.5, "fr", { maximumFractionDigits: 2 }))
    ).toBe("1 234,5");
  });
});
