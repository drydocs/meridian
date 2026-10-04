import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: ["dist/**"],
      thresholds: {
        // Set just under what this package currently measures
        // (98.09/94.20/97.95/98.53) so the floor guards against regressions
        // without failing on rounding. decimal.ts is fully covered; feeds.ts
        // is the remaining drag on branches.
        lines: 98,
        branches: 93,
        functions: 97,
        statements: 97,
      },
    },
  },
});
