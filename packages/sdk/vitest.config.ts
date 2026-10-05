import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      exclude: ["dist/**"],
      lines: 80,
      branches: 80,
      functions: 80,
      statements: 80,
    },
  },
});
