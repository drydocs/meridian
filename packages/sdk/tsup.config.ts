import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  // tsup's declaration build sets `baseUrl`, which TypeScript 6 rejects as
  // deprecated. Only that internal build needs the escape hatch.
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  sourcemap: true,
  clean: true,
  target: "es2020",
  outDir: "dist",
});
