import { describe, it, expect } from "vitest";

import {
  DEFAULT_SLIPPAGE_BPS,
  MAX_ADMIN_SLIPPAGE_BPS,
  SLIPPAGE_BPS,
} from "../constants";

describe("slippage constants (issue #822)", () => {
  it("keeps the documented bps values in one module", () => {
    expect(SLIPPAGE_BPS.FRONTEND_VAULT).toBe(50);
    expect(SLIPPAGE_BPS.DEFINDEX).toBe(10);
    expect(SLIPPAGE_BPS.MIGRATION_DEFAULT).toBe(100);
    expect(SLIPPAGE_BPS.MIGRATION_MAX).toBe(500);
  });

  it("aliases the migration ceiling to the vault admin ceiling", () => {
    // #822 is a single-source-of-truth change: the migration ceiling must be
    // the same binding as MAX_ADMIN_SLIPPAGE_BPS (which mirrors
    // packages/contracts/vault/src/storage.rs), not a second literal 500 that
    // can silently drift away from the contract.
    expect(SLIPPAGE_BPS.MIGRATION_MAX).toBe(MAX_ADMIN_SLIPPAGE_BPS);
  });

  it("derives the default from the frontend value", () => {
    expect(DEFAULT_SLIPPAGE_BPS).toBe(SLIPPAGE_BPS.FRONTEND_VAULT);
  });

  it("keeps every floor positive and within the ceiling", () => {
    const floors = [
      SLIPPAGE_BPS.DEFINDEX,
      SLIPPAGE_BPS.FRONTEND_VAULT,
      SLIPPAGE_BPS.MIGRATION_DEFAULT,
    ];
    for (const floor of floors) {
      expect(floor).toBeGreaterThan(0);
      expect(floor).toBeLessThanOrEqual(SLIPPAGE_BPS.MIGRATION_MAX);
    }
  });
});
