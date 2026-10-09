import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Keeps fully covered files in the table. Vitest still excludes them
      // from the threshold totals below.
      reporter: [["text", { skipFull: false }], "lcov"],
      exclude: ["dist/**"],
      thresholds: {
        // Set just under what this package currently measures
        // (98.92/95.18/100/98.89) so the floor guards against regressions
        // without failing on rounding. The three uncovered lines are
        // defense-only guards the public API cannot reach.
        lines: 98,
        branches: 93,
        functions: 97,
        statements: 97,
      },
    },
  },
});
