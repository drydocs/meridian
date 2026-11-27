import { describe, it, expect } from "vitest";
import {
  formatApy,
  formatCompactUsd,
  formatDate,
  formatDateTime,
  formatDuration,
  formatMoneyInput,
  formatNumber,
  formatUsd,
  INVALID_DATE_FALLBACK,
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

describe("formatDate", () => {
  it("formats a date in en-US", () => {
    expect(formatDate("2026-11-20T15:30:00Z", "en")).toBe("Nov 20, 2026");
  });

  it("formats a date in fr-FR", () => {
    const out = normalize(formatDate("2026-11-20T15:30:00Z", "fr"));
    expect(out).toContain("20");
    expect(out).toContain("nov");
    expect(out).toContain("2026");
  });

  it("honours option overrides (chart tick style)", () => {
    expect(
      formatDate("2026-11-20T15:30:00Z", "en", {
        month: "short",
        day: "numeric",
      })
    ).toBe("Nov 20");
  });

  it("accepts epoch milliseconds and Date objects", () => {
    const ms = Date.UTC(2026, 0, 5);
    expect(formatDate(ms, "en")).toBe("Jan 5, 2026");
    expect(formatDate(new Date(ms), "en")).toBe("Jan 5, 2026");
  });

  it("returns the fallback for invalid input", () => {
    expect(formatDate("not-a-date", "en")).toBe(INVALID_DATE_FALLBACK);
    expect(formatDate(NaN, "fr")).toBe(INVALID_DATE_FALLBACK);
    expect(formatDate("", "en")).toBe(INVALID_DATE_FALLBACK);
  });
});

describe("formatDateTime", () => {
  it("includes the clock time in en-US", () => {
    const out = formatDateTime("2026-11-20T15:30:00Z", "en");
    expect(out).toContain("Nov 20, 2026");
    // Exact clock text depends on the test runner's timezone; the time
    // part just has to be present and not "Invalid Date".
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });

  it("handles midnight without dropping the time", () => {
    const out = formatDateTime("2026-11-20T00:00:00", "en");
    expect(out).toContain("Nov 20, 2026");
    expect(out).toMatch(/\d{1,2}:\d{2}/);
    expect(out).not.toContain("Invalid");
  });

  it("formats in fr-FR", () => {
    const out = normalize(formatDateTime("2026-11-20T15:30:00Z", "fr"));
    expect(out).toContain("2026");
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });

  it("returns the fallback for invalid input", () => {
    expect(formatDateTime("garbage", "en")).toBe(INVALID_DATE_FALLBACK);
  });
});

describe("formatDuration", () => {
  it("returns the fallback for non-finite input", () => {
    expect(formatDuration(Number.NaN)).toBe(INVALID_DATE_FALLBACK);
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe(
      INVALID_DATE_FALLBACK
    );
    expect(formatDuration(Number.NEGATIVE_INFINITY)).toBe(
      INVALID_DATE_FALLBACK
    );
  });

  it("shows whole minutes under an hour", () => {
    expect(formatDuration(5 * 60_000)).toBe("5m");
    expect(formatDuration(59 * 60_000)).toBe("59m");
  });

  it("handles sub-minute durations", () => {
    expect(formatDuration(10_000)).toBe("0m");
    expect(formatDuration(45_000)).toBe("1m");
  });

  it("shows whole hours under a day", () => {
    expect(formatDuration(60 * 60_000)).toBe("1h");
    expect(formatDuration(3 * 60 * 60_000)).toBe("3h");
    expect(formatDuration(23 * 60 * 60_000)).toBe("23h");
  });

  it("shows whole days at a day or more", () => {
    expect(formatDuration(24 * 60 * 60_000)).toBe("1d");
    expect(formatDuration(65 * 60 * 60_000)).toBe("3d");
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
