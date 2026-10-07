import { afterEach, describe, expect, it, vi } from "vitest";

const TESTNET_DEFINDEX_VAULT =
  "CBMVK2JK6NTOT2O4HNQAIQFJY232BHKGLIMXDVQVHIIZKDACXDFZDWHN";

describe("network selection", () => {
  const savedNetwork = process.env.STELLAR_NETWORK;

  afterEach(() => {
    if (savedNetwork === undefined) delete process.env.STELLAR_NETWORK;
    else process.env.STELLAR_NETWORK = savedNetwork;
    vi.resetModules();
  });

  it("defaults to mainnet when STELLAR_NETWORK is unset", async () => {
    delete process.env.STELLAR_NETWORK;
    vi.resetModules();
    const mod = await import("./constants");
    expect(mod.APP_NETWORK.network).toBe("mainnet");
    expect(mod.APP_ADDRESSES).toBe(mod.CONTRACT_ADDRESSES.mainnet);
  });

  it("selects testnet when STELLAR_NETWORK is testnet", async () => {
    process.env.STELLAR_NETWORK = "testnet";
    vi.resetModules();
    const mod = await import("./constants");
    expect(mod.APP_NETWORK.network).toBe("testnet");
    expect(mod.APP_ADDRESSES.defindex.vault).toBe(TESTNET_DEFINDEX_VAULT);
  });
});

describe("isDefindexConfigured", () => {
  const savedNetwork = process.env.STELLAR_NETWORK;
  const savedVault = process.env.DEFINDEX_VAULT_ID;

  afterEach(() => {
    if (savedNetwork === undefined) delete process.env.STELLAR_NETWORK;
    else process.env.STELLAR_NETWORK = savedNetwork;
    if (savedVault === undefined) delete process.env.DEFINDEX_VAULT_ID;
    else process.env.DEFINDEX_VAULT_ID = savedVault;
    vi.resetModules();
  });

  it("reports configured when DEFINDEX_VAULT_ID is set", async () => {
    delete process.env.STELLAR_NETWORK;
    process.env.DEFINDEX_VAULT_ID = TESTNET_DEFINDEX_VAULT;
    vi.resetModules();
    const { isDefindexConfigured } = await import("./constants");
    expect(isDefindexConfigured()).toBe(true);
  });

  it("reports unconfigured when the env var is unset and the network has no vault", async () => {
    // Mainnet carries no DeFindex vault address, so the fallback is empty.
    delete process.env.STELLAR_NETWORK;
    delete process.env.DEFINDEX_VAULT_ID;
    vi.resetModules();
    const { isDefindexConfigured } = await import("./constants");
    expect(isDefindexConfigured()).toBe(false);
  });

  it("falls back to the network vault when the env var is unset on testnet", async () => {
    process.env.STELLAR_NETWORK = "testnet";
    delete process.env.DEFINDEX_VAULT_ID;
    vi.resetModules();
    const { isDefindexConfigured } = await import("./constants");
    expect(isDefindexConfigured()).toBe(true);
  });
});
