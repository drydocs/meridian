import { describe, expect, it, vi } from "vitest";

const ctor = vi.fn();
vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  class FakeServer {
    constructor(url: string, opts: unknown) {
      ctor(url, opts);
    }
  }
  return { ...actual, rpc: { ...actual.rpc, Server: FakeServer } };
});

import { DEFAULT_RPC_TIMEOUT_MS, VaultBase } from "./vault-base.js";
import type { VaultConfig } from "./types.js";

const BASE: VaultConfig = {
  contractId: "CAIQBVLBIUWQGE6DQUHDMZ2QWI7QP6KTCN7GP2BIZ6JZC4ES47JO4SSM",
  network: {
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    passphrase: "Test SDF Network ; September 2015",
  },
};

class Vault extends VaultBase {
  protected get caller() {
    return "G";
  }
  build() {
    return this.makeRpcServer();
  }
}

describe("RPC client timeout", () => {
  it("defaults to 12000ms for backwards compatibility", () => {
    ctor.mockClear();
    new Vault(BASE).build();
    expect(DEFAULT_RPC_TIMEOUT_MS).toBe(12_000);
    expect(ctor).toHaveBeenCalledWith(BASE.network.rpcUrl, { timeout: 12_000 });
  });

  it("uses timeouts.rpcMs when provided", () => {
    ctor.mockClear();
    new Vault({ ...BASE, timeouts: { rpcMs: 2500 } }).build();
    expect(ctor).toHaveBeenCalledWith(BASE.network.rpcUrl, { timeout: 2500 });
  });
});
