import { describe, it, expect } from "vitest";

import { formatUsd } from "../../lib/format";

describe("formatUsd", () => {
  it("formats a typical USD amount with en locale", () => {
    expect(formatUsd(1234.56, "en")).toBe("$1,234.56");
  });

  it("formats zero with two fractional digits", () => {
    expect(formatUsd(0, "en")).toBe("$0.00");
  });

  it("rounds fractional cents to two digits", () => {
    // 0.005 should round to $0.01 (half-up behavior of Intl)
    expect(formatUsd(0.005, "en")).toBe("$0.01");
  });

  it("formats a large value with thousands separators", () => {
    expect(formatUsd(1_000_000, "en")).toBe("$1,000,000.00");
  });

  it("formats a small fractional value", () => {
    expect(formatUsd(0.5, "en")).toBe("$0.50");
  });

  it("formats the same value differently under fr locale", () => {
    // fr locale uses non-breaking space as thousands separator and "," as decimal
    const result = formatUsd(1234.56, "fr");
    // The non-breaking space char code is U+202F (narrow no-break space, used by Node 20+ Intl)
    // We assert the decimal separator is "," not "." — this is the meaningful difference for fr
    expect(result).toMatch(/1[\s\u202F]234,56/);
    // The currency symbol position and code differ by Node version, so we only assert the structure
  });

  it("handles negative values consistently with positive", () => {
    const positive = formatUsd(42.99, "en");
    const negative = formatUsd(-42.99, "en");
    // Negative is formatted with the same magnitude, with a leading minus or parentheses depending on locale
    expect(negative).toContain("42.99");
    expect(negative).not.toBe(positive);
  });
});
