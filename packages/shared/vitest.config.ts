import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["dist/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: ["dist/**", "node_modules/**"],
      thresholds: {
        lines: 90,
        branches: 95,
        functions: 85,
        statements: 90,
      },
    },
  },
});
