import { describe, it, expect, vi, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

vi.mock("@meridian/stellar-sdk-helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@meridian/stellar-sdk-helpers")>();
  return {
    ...actual,
    // The header under test doesn't depend on vault contents, and the real
    // fetch would reach Stellar RPC / DeFiLlama from a unit test.
    fetchAllVaults: vi.fn(async () => [
      {
        id: "meridian-usdc",
        protocol: "meridian",
        asset: "USDC",
        name: "Meridian",
        label: "USDC Vault",
        apy: 5,
        tvl: 1000,
        userBalance: 0,
        riskLevel: "safe",
      },
    ]),
  };
});

const fakeReq = (obj: object) =>
  ({ headers: {}, ...obj }) as unknown as VercelRequest;

interface FakeRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
  setHeader(key: string, value: string): void;
}

function makeRes(): FakeRes & VercelResponse {
  const r: FakeRes = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code: number) {
      r.statusCode = code;
      return r;
    },
    json(payload: unknown) {
      r.body = payload;
      return r;
    },
    setHeader(key: string, value: string) {
      r.headers[key] = value;
    },
  };
  return r as unknown as FakeRes & VercelResponse;
}

const MAINNET_CACHE_HEADER = "public, s-maxage=60, stale-while-revalidate=300";

// APP_NETWORK is resolved from STELLAR_NETWORK once, at @meridian/shared
// module load, so each network case needs a fresh module graph rather than a
// mutated constant.
const savedNetwork = process.env.STELLAR_NETWORK;

afterEach(() => {
  if (savedNetwork === undefined) delete process.env.STELLAR_NETWORK;
  else process.env.STELLAR_NETWORK = savedNetwork;
  vi.resetModules();
});

describe("vaultReadCacheControl", () => {
  it("caches mainnet vault reads at the CDN", async () => {
    delete process.env.STELLAR_NETWORK;
    vi.resetModules();
    const { vaultReadCacheControl } = await import("../_lib/middleware.js");
    expect(vaultReadCacheControl()).toBe(MAINNET_CACHE_HEADER);
  });

  it("serves testnet vault reads uncached", async () => {
    process.env.STELLAR_NETWORK = "testnet";
    vi.resetModules();
    const { vaultReadCacheControl } = await import("../_lib/middleware.js");
    expect(vaultReadCacheControl()).toBe("no-store");
  });
});

// #1051: the detail endpoint used to answer with
// `public, s-maxage=60, stale-while-revalidate=300` on every network, so a
// testnet deposit was invisible behind the CDN for up to a minute while the
// list endpoint (already no-store on testnet) showed the new balance.
describe("GET /api/v1/vaults/:vaultId on testnet (#1051)", () => {
  it("serves a 200 single-vault read with no-store", async () => {
    process.env.STELLAR_NETWORK = "testnet";
    vi.resetModules();
    const { default: handler } = await import("../v1/vaults/[vaultId]");
    const res = makeRes();
    await handler(
      fakeReq({ method: "GET", query: { vaultId: "meridian-usdc" } }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });
});
