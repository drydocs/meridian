#!/usr/bin/env node
/**
 * Reduces a full Lighthouse JSON report to the small, reviewable mobile
 * baseline checked in at apps/web/lighthouse/mobile-baseline.json (#1428).
 *
 *   node scripts/summarize-lighthouse.mjs <lighthouse-report.json> > lighthouse/mobile-baseline.json
 */
import { readFileSync } from "node:fs";

const input = process.argv[2];
if (!input) {
  console.error(
    "Usage: node scripts/summarize-lighthouse.mjs <lighthouse-report.json>"
  );
  process.exit(1);
}

const report = JSON.parse(readFileSync(input, "utf8"));

function audit(id) {
  const result = report.audits?.[id];
  if (!result) return null;
  return {
    score: result.score ?? null,
    value:
      typeof result.numericValue === "number"
        ? Math.round(result.numericValue * 100) / 100
        : null,
    displayValue: result.displayValue ?? null,
  };
}

const summary = {
  issue: "https://github.com/drydocs/meridian/issues/1428",
  url: report.finalDisplayedUrl ?? report.finalUrl ?? report.requestedUrl,
  lighthouseVersion: report.lighthouseVersion,
  capturedAt: report.fetchTime,
  formFactor: report.configSettings?.formFactor ?? null,
  screenEmulation: report.configSettings?.screenEmulation ?? null,
  throttling: report.configSettings?.throttling ?? null,
  scores: Object.fromEntries(
    Object.entries(report.categories ?? {}).map(([id, category]) => [
      id,
      category.score,
    ])
  ),
  metrics: {
    "first-contentful-paint": audit("first-contentful-paint"),
    "largest-contentful-paint": audit("largest-contentful-paint"),
    "total-blocking-time": audit("total-blocking-time"),
    "cumulative-layout-shift": audit("cumulative-layout-shift"),
    "speed-index": audit("speed-index"),
    interactive: audit("interactive"),
    "total-byte-weight": audit("total-byte-weight"),
  },
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
