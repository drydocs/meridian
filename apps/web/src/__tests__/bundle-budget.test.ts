import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import {
  evaluateBundleBudget,
  getInitialJsAssets,
  runBundleCheck,
} from "../../scripts/check-bundle-budget.mjs";

describe("Bundle Report & CI Budget Gate (#1307)", () => {
  const webRoot = resolve(__dirname, "../..");
  const reportPath = resolve(webRoot, "bundle-report.json");
  const distHtmlPath = resolve(webRoot, "dist/index.html");

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

    expect(report.current).toBeDefined();
    expect(typeof report.current.initialJsBytes).toBe("number");
    expect(report.current.initialJsBytes).toBeLessThanOrEqual(
      report.budget.maxInitialJsBytes
    );

    // Ensure ephemeral hashed chunk names are not committed
    expect(report.current.chunks).toBeUndefined();
  });

  it("verifies initial JavaScript is significantly reduced against the recorded baseline", () => {
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    const baseline = report.baseline.initialJsBytes;
    const current = report.current.initialJsBytes;

    expect(current).toBeLessThan(baseline);
    const reductionPercent = ((baseline - current) / baseline) * 100;
    expect(reductionPercent).toBeGreaterThan(50); // > 50% reduction
  });

  describe("evaluateBundleBudget (real gate logic)", () => {
    it("passes when initial JS is within the configured budget", () => {
      const report = JSON.parse(readFileSync(reportPath, "utf-8"));
      const result = evaluateBundleBudget(
        report,
        report.budget.maxInitialJsBytes - 1024
      );

      expect(result.passed).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.reductionPercent).toBeGreaterThan(0);
    });

    it("fails when initial JS exceeds the configured budget limit", () => {
      const report = JSON.parse(readFileSync(reportPath, "utf-8"));
      const result = evaluateBundleBudget(
        report,
        report.budget.maxInitialJsBytes + 1024
      );

      expect(result.passed).toBe(false);
      expect(result.error).toContain("exceeds budget limit");
    });

    it("fails when initial JS equals or exceeds baseline", () => {
      const report = JSON.parse(readFileSync(reportPath, "utf-8"));
      const result = evaluateBundleBudget(
        report,
        report.baseline.initialJsBytes
      );

      expect(result.passed).toBe(false);
      expect(result.error).toContain("is not less than baseline");
    });
  });

  describe("runBundleCheck (end-to-end check on built assets)", () => {
    it("runs the real check script against dist and validates startup assets", () => {
      if (!existsSync(distHtmlPath)) {
        // Skip if dist hasn't been built in the current test run
        return;
      }

      const result = runBundleCheck({ webRoot, reportPath });
      expect(result.passed).toBe(true);
      expect(result.initialJsBytes).toBeLessThanOrEqual(500 * 1024);

      const { assets } = getInitialJsAssets(webRoot);
      expect(assets.length).toBeGreaterThan(0);

      // Verify that all measured startup assets are JS files
      for (const asset of assets) {
        expect(asset.file.endsWith(".js")).toBe(true);
      }

      // Verify that admin, chart, and wallet SDK off-path chunks are not in the startup bundle
      const fileNames = assets.map((a: { file: string }) =>
        a.file.toLowerCase()
      );
      for (const name of fileNames) {
        expect(name).not.toContain("admin");
        expect(name).not.toContain("chart");
        expect(name).not.toContain("recharts");
        expect(name).not.toContain("stellar-sdk");
      }
    });
  });
});
