import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SDK_VERSION } from "./index.js";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as { version: string };

describe("SDK_VERSION", () => {
  it("matches the package.json version", () => {
    expect(SDK_VERSION).toBe(pkg.version);
  });

  it("is a semver version", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });
});
