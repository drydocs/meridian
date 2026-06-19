import { describe, it, expect } from "vitest";
import { buildDefindexDepositTx, buildDefindexWithdrawTx, stroopsToUnits } from "./defindex";
import type { StellarNetwork } from "./types";

const network: StellarNetwork = {
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
};
const config = { vaultId: "CVAULT", network };
const ADDR = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

// The positive-amount guards run before any network access, so they are
// unit-testable without an RPC server.
describe("buildDefindexDepositTx", () => {
  it("rejects a non-positive amount", async () => {
    await expect(buildDefindexDepositTx(config, ADDR, 0n)).rejects.toThrow(/positive/);
    await expect(buildDefindexDepositTx(config, ADDR, -1n)).rejects.toThrow(/positive/);
  });
});

describe("buildDefindexWithdrawTx", () => {
  it("rejects non-positive shares", async () => {
    await expect(buildDefindexWithdrawTx(config, ADDR, 0n)).rejects.toThrow(/positive/);
  });
});

describe("stroopsToUnits", () => {
  it("converts small values exactly", () => {
    expect(stroopsToUnits(10_000_000n)).toBe(1);
    expect(stroopsToUnits(5_000_000n)).toBe(0.5);
  });

  it("preserves precision for values above Number.MAX_SAFE_INTEGER stroops", () => {
    // 1 billion units = 10_000_000_000_000_000 stroops (1e16), above MAX_SAFE_INTEGER
    const stroops = 10_000_000_000_000_000n;
    expect(stroopsToUnits(stroops)).toBe(1_000_000_000);
  });

  it("handles fractional units correctly", () => {
    // 1.0000001 units = 10_000_001 stroops
    expect(stroopsToUnits(10_000_001n)).toBeCloseTo(1.0000001, 7);
  });
});
