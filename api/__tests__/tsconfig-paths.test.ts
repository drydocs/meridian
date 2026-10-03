import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// @vercel/node runs its own tsc over api/** during the serverless function
// build, separate from `pnpm typecheck`/`pnpm typecheck:api`. Vercel restores
// packages/*/dist from the previous deployment's build cache, so if that
// type-check resolves @meridian/* through the emitted declarations it can read
// stale .d.ts files that predate current exports and fail with TS2305
// "no exported member" even though the exports exist in source. These tests
// pin the fix: api/tsconfig.json must map @meridian/* to live workspace src.
const tsconfig = JSON.parse(
  readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8")
) as {
  compilerOptions?: { paths?: Record<string, string[]> };
};

const WORKSPACE_PACKAGES = [
  "@meridian/shared",
  "@meridian/api-core",
  "@meridian/stellar-sdk-helpers",
];

function sourceTarget(pkg: string): string {
  const targets = tsconfig.compilerOptions?.paths?.[pkg];
  if (!targets || targets.length !== 1 || !targets[0]) {
    throw new Error(`${pkg} must map to exactly one workspace source path`);
  }
  return targets[0];
}

describe("api/tsconfig.json workspace paths", () => {
  it.each(WORKSPACE_PACKAGES)("maps %s to workspace source", (pkg) => {
    const target = sourceTarget(pkg);
    // Must point at src, never at the emitted dist declarations that Vercel's
    // build cache can restore stale.
    expect(target).toContain("/src");
    expect(target).not.toContain("/dist");
  });

  it.each(WORKSPACE_PACKAGES)(
    "resolves %s to an existing source entrypoint",
    (pkg) => {
      const entrypoint = new URL(
        `../${sourceTarget(pkg)}/index.ts`,
        import.meta.url
      );
      expect(existsSync(entrypoint), `${entrypoint.pathname} must exist`).toBe(
        true
      );
    }
  );
});
