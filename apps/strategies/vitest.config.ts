import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@meridian/strategies": fileURLToPath(
        new URL("../../packages/strategies/src/index.ts", import.meta.url)
      ),
    },
  },
  test: {
    environment: "node",
  },
});
