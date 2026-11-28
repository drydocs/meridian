import { describe, expect, it } from "vitest";
import {
  hashMismatches,
  reproducibleBuildManifestSchema,
  reproducibleBuildMismatches,
  type ReproducibleBuildManifest,
} from "./reproducible-build";

const hash = "a".repeat(64);
const otherHash = "b".repeat(64);

const manifest: ReproducibleBuildManifest = {
  version: 1,
  toolchain: {
    builder: "stellar",
    rustc: "rustc 1.100.0 (0ef1bc386 2026-11-09)",
    sorobanSdk: "22.0.11",
    stellarCli: "28.0.0",
    target: "wasm32v1-none",
  },
  contracts: {
    meridian_vault: hash,
    meridian_blend_adapter: hash,
  },
};

describe("reproducibleBuildManifestSchema", () => {
  it("accepts a manifest that records the toolchain and every hash", () => {
    expect(reproducibleBuildManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it("accepts a cargo build without a Stellar CLI version", () => {
    const cargoBuild = structuredClone(manifest);
    cargoBuild.toolchain.builder = "cargo";
    cargoBuild.toolchain.stellarCli = null;

    expect(reproducibleBuildManifestSchema.parse(cargoBuild)).toEqual(
      cargoBuild
    );
  });

  it("rejects an invalid WASM hash", () => {
    const invalid = structuredClone(manifest);
    invalid.contracts.meridian_vault = "not-a-hash";

    expect(() => reproducibleBuildManifestSchema.parse(invalid)).toThrow();
  });

  it("rejects fields outside the recorded manifest", () => {
    const withExtra = {
      ...structuredClone(manifest),
      secretKey: "S...",
    };

    expect(() => reproducibleBuildManifestSchema.parse(withExtra)).toThrow();
  });
});

describe("hashMismatches", () => {
  it("returns no mismatches for identical builds", () => {
    expect(
      hashMismatches(manifest.contracts, { ...manifest.contracts })
    ).toEqual([]);
  });

  it("reports a changed hash", () => {
    expect(
      hashMismatches(manifest.contracts, {
        ...manifest.contracts,
        meridian_vault: otherHash,
      })
    ).toEqual([
      {
        contract: "meridian_vault",
        expected: hash,
        actual: otherHash,
      },
    ]);
  });

  it("reports a WASM missing from one build", () => {
    expect(
      hashMismatches(manifest.contracts, {
        meridian_vault: hash,
      })
    ).toEqual([
      {
        contract: "meridian_blend_adapter",
        expected: hash,
        actual: null,
      },
    ]);
  });

  it("reports a WASM unexpected in the other build", () => {
    expect(
      hashMismatches(
        { meridian_vault: hash },
        { meridian_vault: hash, meridian_defindex_adapter: otherHash }
      )
    ).toEqual([
      {
        contract: "meridian_defindex_adapter",
        expected: null,
        actual: otherHash,
      },
    ]);
  });
});

describe("reproducibleBuildMismatches", () => {
  it("compares the manifest's contract hashes with a staged build", () => {
    expect(
      reproducibleBuildMismatches(manifest, {
        meridian_vault: hash,
        meridian_blend_adapter: otherHash,
      })
    ).toEqual([
      {
        contract: "meridian_blend_adapter",
        expected: hash,
        actual: otherHash,
      },
    ]);
  });
});
