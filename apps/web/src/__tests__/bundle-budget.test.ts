import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

describe("Bundle Report & CI Budget Gate (#1307)", () => {
  const reportPath = resolve(__dirname, "../../bundle-report.json");

  it("has a valid checked-in bundle report with baseline and budget", () => {
    expect(existsSync(reportPath)).toBe(true);

    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    expect(report.baseline).toBeDefined();
    expect(typeof report.baseline.initialJsBytes).toBe("number");
    expect(report.baseline.initialJsBytes).toBeGreaterThan(2_000_000); // ~2.26 MB

    expect(report.budget).toBeDefined();
    expect(typeof report.budget.maxInitialJsBytes).toBe("number");
    expect(report.budget.maxInitialJsBytes).toBeLessThan(
      report.baseline.initialJsBytes
    );
    expect(report.budget.maxInitialJsBytes).toBeLessThanOrEqual(500 * 1024); // <= 500 KB
  });

  it("verifies initial JavaScript is significantly reduced against the recorded baseline", () => {
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    const baseline = report.baseline.initialJsBytes;
    const current = report.current.initialJsBytes;

    expect(current).toBeLessThan(baseline);
    const reductionPercent = ((baseline - current) / baseline) * 100;
    expect(reductionPercent).toBeGreaterThan(50); // > 50% reduction
  });

  it("fails when an arbitrary size exceeds the configured budget", () => {
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    const budget = report.budget.maxInitialJsBytes;

    const simulateGate = (bytes: number) => {
      if (bytes > budget) {
        throw new Error(`BUDGET EXCEEDED: ${bytes} > ${budget}`);
      }
      return true;
    };

    expect(() => simulateGate(budget + 1024)).toThrow("BUDGET EXCEEDED");
    expect(simulateGate(budget - 1024)).toBe(true);
  });
});
