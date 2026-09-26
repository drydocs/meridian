import { describe, it, expect } from "vitest";
import {
  DEFAULT_SLIPPAGE_BPS,
  DEFINDEX_SLIPPAGE_BPS,
  MIGRATION_DEFAULT_SLIPPAGE_BPS,
  MIGRATION_MAX_SLIPPAGE_BPS,
  SLIPPAGE_BPS,
} from "../constants";

describe("slippage constants (issue #822)", () => {
  it("keeps documented bps values in one module", () => {
    expect(SLIPPAGE_BPS.FRONTEND_VAULT).toBe(50);
    expect(DEFAULT_SLIPPAGE_BPS).toBe(50);
    expect(DEFINDEX_SLIPPAGE_BPS).toBe(10);
    expect(MIGRATION_DEFAULT_SLIPPAGE_BPS).toBe(100);
    expect(MIGRATION_MAX_SLIPPAGE_BPS).toBe(500);
  });
});
