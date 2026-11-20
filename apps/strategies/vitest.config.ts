import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const src = (pkg: string) =>
  fileURLToPath(new URL(`../../packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Workspace packages point their entry at dist/, which is not built
      // during tests; resolve to source like tsconfig `paths` does. The
      // engine's own workspace dependencies need the same treatment.
      "@meridian/strategies": src("strategies"),
      "@meridian/shared": src("shared"),
      "@meridian/stellar-sdk-helpers": src("stellar-sdk-helpers"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/setupTests.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/main.tsx", "src/vite-env.d.ts", "src/**/*.test.{ts,tsx}", "src/setupTests.ts"],
      thresholds: { lines: 90, branches: 80, functions: 90, statements: 90 },
    },
  },
});
