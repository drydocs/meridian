import { describe, expect, it, vi } from "vitest";

import { planMigrationKeeper } from "./keeper-plan";
import type { RateSourceFn } from "./migration-keeper";
import type { KeeperLogger } from "./keeper-retry";

const vault = {
  vaultId: "vault-1",
  vaultContractId: "CVAULT",
  currentAdapterId: "CURRENT",
  currentProtocol: "blend",
  currentPoolId: "POOL",
};

function logger(): KeeperLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function deps(rateSource: RateSourceFn = vi.fn(async () => null)) {
  return {
    discoverVaults: async () => ({ vaults: [vault], failures: [] }),
    rateSource,
    resolveCandidatePool: async () => "CANDIDATE_POOL",
    logger: logger(),
    sleep: async () => {},
  };
}

describe("planMigrationKeeper", () => {
  it("reports a would-migrate decision and candidate ranking when configured", async () => {
    const rateSource = vi.fn(async (query: { adapterId: string }) =>
      query.adapterId === "CURRENT" ? 500 : 700
    );

    const result = await planMigrationKeeper(
      {
        MERIDIAN_ADAPTER_DEFINDEX_ID: "DEFINDEX",
        MERIDIAN_MIGRATION_MIN_IMPROVEMENT_BPS: "50",
      },
      deps(rateSource)
    );

    expect(result.configured).toBe(true);
    expect(result.candidateAdapters).toEqual({ defindex: "DEFINDEX" });
    expect(result.vaults[0]?.currentRateBps).toBe(500);
    expect(result.vaults[0]?.wouldMigrate).toBe(true);
    expect(result.vaults[0]?.bestCandidate).toEqual({
      protocol: "defindex",
      adapterId: "DEFINDEX",
      rateBps: 700,
      improvementBps: 200,
    });
    expect(result.vaults[0]?.candidates).toEqual([
      {
        protocol: "defindex",
        adapterId: "DEFINDEX",
        rateBps: 700,
        improvementBps: 200,
      },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("still discovers vaults when no candidate adapters are configured", async () => {
    const rateSource = vi.fn(async () => null);

    const result = await planMigrationKeeper({}, deps(rateSource));

    expect(result.configured).toBe(false);
    expect(result.discoveredVaults).toBe(1);
    expect(result.vaults[0]?.wouldMigrate).toBe(false);
    expect(result.vaults[0]?.skipReason).toBe(
      "no candidate adapters configured"
    );
    expect(result.skipped).toEqual([
      { vaultId: "vault-1", reason: "no candidate adapters configured" },
    ]);
    expect(rateSource).not.toHaveBeenCalled();
  });

  it("reports no candidate when every configured adapter is the current one", async () => {
    const rateSource = vi.fn(async () => 500);

    const result = await planMigrationKeeper(
      { MERIDIAN_ADAPTER_BLEND_ID: "CURRENT" },
      deps(rateSource)
    );

    expect(result.vaults[0]?.wouldMigrate).toBe(false);
    expect(result.vaults[0]?.skipReason).toBe(
      "every configured candidate is the vault's current adapter"
    );
    expect(result.skipped).toEqual([
      {
        vaultId: "vault-1",
        reason: "every configured candidate is the vault's current adapter",
      },
    ]);
    expect(rateSource).not.toHaveBeenCalled();
  });

  it("reports no candidate when the improvement threshold is not met", async () => {
    const rateSource = vi.fn(async (query: { adapterId: string }) =>
      query.adapterId === "CURRENT" ? 500 : 520
    );

    const result = await planMigrationKeeper(
      {
        MERIDIAN_ADAPTER_DEFINDEX_ID: "DEFINDEX",
        MERIDIAN_MIGRATION_MIN_IMPROVEMENT_BPS: "50",
      },
      deps(rateSource)
    );

    expect(result.vaults[0]?.wouldMigrate).toBe(false);
    expect(result.vaults[0]?.skipReason).toBe(
      "no candidate clears the improvement threshold"
    );
    expect(result.vaults[0]?.candidates).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe(
      "no candidate clears the improvement threshold"
    );
  });
});
