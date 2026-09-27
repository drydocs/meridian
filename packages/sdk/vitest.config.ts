import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: ["dist/**"],
      thresholds: {
        lines: 85,
        branches: 80,
        functions: 85,
        statements: 85,
      },
    },
  },
});
