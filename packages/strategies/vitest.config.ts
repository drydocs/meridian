import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: [
        "src/config.ts",
        "src/decimal.ts",
        "src/liquidation.ts",
        "src/monitor.ts",
        "src/projections.ts",
        "src/self-repaying-loan.ts",
      ],
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
        statements: 90,
      },
    },
  },
});
