import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: ["dist/**"],
      thresholds: {
        lines: 90,
        branches: 95,
        functions: 85,
        statements: 90,
      },
    },
  },
});