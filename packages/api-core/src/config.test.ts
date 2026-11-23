import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@meridian/stellar-sdk-helpers", () => ({
  fetchCoordinatorState: vi.fn(async () => ({
    protocol: "blend",
    adapterId: "CBNKERYAG7VZNBH2V3TF5JBXLD3MXLVQW5GG4AO445EUDCPKP4D2DDP2",
    totalShares: 1000,
    totalAssets: 1050,
    paused: false,
  })),
}));

const savedEnv = {
  STELLAR_NETWORK: process.env.STELLAR_NETWORK,
  DEFINDEX_VAULT_ID: process.env.DEFINDEX_VAULT_ID,
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  REDIS_URL: process.env.REDIS_URL,
  CRON_SECRET: process.env.CRON_SECRET,
  MERIDIAN_KEEPER_SECRET_KEY: process.env.MERIDIAN_KEEPER_SECRET_KEY,
  MERIDIAN_MIGRATION_KEEPER_SECRET_KEY:
    process.env.MERIDIAN_MIGRATION_KEEPER_SECRET_KEY,
  MERIDIAN_ALERT_WEBHOOK_URL: process.env.MERIDIAN_ALERT_WEBHOOK_URL,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  restoreEnv();
  vi.resetModules();
});

describe("handleGetConfig", () => {
  it("returns mainnet config derived from shared constants and live active adapter", async () => {
    delete process.env.STELLAR_NETWORK;
    delete process.env.DEFINDEX_VAULT_ID;
    vi.resetModules();

    const shared = await import("@meridian/shared");
    const { handleGetConfig } = await import("./config");
    const helpers = await import("@meridian/stellar-sdk-helpers");

    const result = await handleGetConfig();

    expect(result.status).toBe(200);
    expect(result.error).toBeUndefined();
    expect(helpers.fetchCoordinatorState).toHaveBeenCalledWith({
      contractId: shared.CONTRACT_ADDRESSES.mainnet.vault,
      network: shared.STELLAR_NETWORKS.mainnet,
    });
    expect(result.body).toEqual({
      network: shared.STELLAR_NETWORKS.mainnet.network,
      passphrase: shared.STELLAR_NETWORKS.mainnet.passphrase,
      contracts: {
        vault: shared.CONTRACT_ADDRESSES.mainnet.vault,
        usdc: shared.CONTRACT_ADDRESSES.mainnet.usdc,
        musdc: shared.CONTRACT_ADDRESSES.mainnet.musdc,
        eurc: shared.CONTRACT_ADDRESSES.mainnet.eurc,
        blendPool: shared.CONTRACT_ADDRESSES.mainnet.blend.pool,
        defindexVault: null,
        defindexFactory: null,
      },
      activeAdapter: {
        address: "CBNKERYAG7VZNBH2V3TF5JBXLD3MXLVQW5GG4AO445EUDCPKP4D2DDP2",
        protocol: "blend",
      },
      degraded: false,
      supportedAssets: [...shared.SUPPORTED_STABLECOINS],
      features: {
        defindexEnabled: false,
        musdcTrustlineRequired: false,
        riskAcknowledgementRequired: true,
      },
    });
  });

  it("returns testnet config and feature flags when STELLAR_NETWORK=testnet", async () => {
    process.env.STELLAR_NETWORK = "testnet";
    delete process.env.DEFINDEX_VAULT_ID;
    vi.resetModules();

    const shared = await import("@meridian/shared");
    const { handleGetConfig } = await import("./config");

    const result = await handleGetConfig();

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      network: "testnet",
      passphrase: shared.STELLAR_NETWORKS.testnet.passphrase,
      contracts: {
        vault: shared.CONTRACT_ADDRESSES.testnet.vault,
        usdc: shared.CONTRACT_ADDRESSES.testnet.usdc,
        musdc: shared.CONTRACT_ADDRESSES.testnet.musdc,
        eurc: shared.CONTRACT_ADDRESSES.testnet.eurc,
        blendPool: shared.CONTRACT_ADDRESSES.testnet.blend.pool,
        defindexVault: shared.CONTRACT_ADDRESSES.testnet.defindex.vault,
        defindexFactory: shared.CONTRACT_ADDRESSES.testnet.defindex.factory,
      },
      degraded: false,
      supportedAssets: [...shared.SUPPORTED_STABLECOINS],
      features: {
        defindexEnabled: true,
        musdcTrustlineRequired: false,
        riskAcknowledgementRequired: true,
      },
    });
  });

  it("reflects DEFINDEX_VAULT_ID override in contracts and feature flags", async () => {
    delete process.env.STELLAR_NETWORK;
    process.env.DEFINDEX_VAULT_ID =
      "CBMVK2JK6NTOT2O4HNQAIQFJY232BHKGLIMXDVQVHIIZKDACXDFZDWHN";
    vi.resetModules();

    const { handleGetConfig } = await import("./config");
    const result = await handleGetConfig();

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      contracts: {
        defindexVault:
          "CBMVK2JK6NTOT2O4HNQAIQFJY232BHKGLIMXDVQVHIIZKDACXDFZDWHN",
      },
      features: {
        defindexEnabled: true,
      },
    });
  });

  it("degrades gracefully with activeAdapter=null when coordinator lookup fails", async () => {
    delete process.env.STELLAR_NETWORK;
    vi.resetModules();

    const err = new Error("rpc timeout");
    const helpers = await import("@meridian/stellar-sdk-helpers");
    vi.mocked(helpers.fetchCoordinatorState).mockRejectedValueOnce(err);

    const { handleGetConfig } = await import("./config");
    const result = await handleGetConfig();

    expect(result.status).toBe(200);
    expect(result.error).toBe(err);
    expect(result.body).toMatchObject({
      network: "mainnet",
      activeAdapter: null,
      degraded: true,
    });
  });

  it("skips active adapter lookup when no vault address is configured", async () => {
    vi.resetModules();
    vi.doMock("@meridian/shared", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@meridian/shared")>();
      return {
        ...actual,
        APP_ADDRESSES: {
          ...actual.APP_ADDRESSES,
          vault: "",
        },
      };
    });

    const helpers = await import("@meridian/stellar-sdk-helpers");
    const { handleGetConfig } = await import("./config");
    const result = await handleGetConfig();

    expect(result.status).toBe(200);
    expect(result.error).toBeUndefined();
    expect(helpers.fetchCoordinatorState).not.toHaveBeenCalled();
    expect(result.body).toMatchObject({
      activeAdapter: null,
      degraded: false,
    });

    vi.doUnmock("@meridian/shared");
  });

  it("never exposes secrets, private URLs, RPC URLs, keeper settings, or admin state", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://private-redis.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "super-secret-upstash-token";
    process.env.REDIS_URL = "rediss://default:secret@redis.internal:6379";
    process.env.CRON_SECRET = "super-secret-cron-token";
    process.env.MERIDIAN_KEEPER_SECRET_KEY = "SSECRETKEEPERKEY123456";
    process.env.MERIDIAN_MIGRATION_KEEPER_SECRET_KEY =
      "SSECRETADMINMIGRATIONKEY789";
    process.env.MERIDIAN_ALERT_WEBHOOK_URL =
      "https://hooks.slack.com/services/T000/B000/SECRET";
    vi.resetModules();

    const shared = await import("@meridian/shared");
    const { handleGetConfig } = await import("./config");
    const result = await handleGetConfig();

    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain(shared.APP_NETWORK.rpcUrl);
    expect(serialized).not.toContain("rpcUrl");
    expect(serialized).not.toContain("upstash");
    expect(serialized).not.toContain("redis");
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("SSECRET");
    expect(serialized).not.toContain("hooks.slack.com");
    expect(serialized).not.toContain("totalShares");
    expect(serialized).not.toContain("totalAssets");
    expect(serialized).not.toContain("paused");
  });
});
