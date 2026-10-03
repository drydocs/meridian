import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { getCachedVaults, setCachedVaults } from "./vault-cache";
import type { ApiVault } from "./vaults";

const REST_URL = "https://vault-cache-test.upstash.io";
const REST_TOKEN = "test-token";

const VAULTS: ApiVault[] = [
  {
    id: "blend-usdc-fixed",
    protocol: "blend",
    asset: "USDC",
    name: "Blend USDC",
    label: "Blend USDC Fixed",
    apy: 5.12,
    tvl: 5_000_000,
    userBalance: 0,
    riskLevel: "safe",
  },
];

function useCredentials(): void {
  process.env.UPSTASH_REDIS_REST_URL = REST_URL;
  process.env.UPSTASH_REDIS_REST_TOKEN = REST_TOKEN;
}

function clearCredentials(): void {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

/** The exact command bodies the cache is expected to put on the wire. */
const GET_MAINNET = JSON.stringify(["GET", "vault-cache:mainnet"]);
const SET_MAINNET = JSON.stringify([
  "SETEX",
  "vault-cache:mainnet",
  60,
  JSON.stringify(VAULTS),
]);

function stubReply(result: unknown) {
  const mock = vi.fn(
    async () => new Response(JSON.stringify({ result }), { status: 200 })
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("vault-cache", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearCredentials();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearCredentials();
  });

  // Regression: the client used to be constructed at module load as
  // `new Redis({ url: "", token: "" })`, so an unconfigured cache still fired
  // a request for every read and write instead of being skipped.
  it("does not touch the network when the credentials are unset", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    expect(await getCachedVaults("mainnet")).toBeNull();
    await expect(setCachedVaults("mainnet", VAULTS)).resolves.toBeUndefined();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("treats a partially configured pair as unconfigured", async () => {
    process.env.UPSTASH_REDIS_REST_URL = REST_URL;
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    expect(await getCachedVaults("mainnet")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only pair as unconfigured", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "  ";
    process.env.UPSTASH_REDIS_REST_TOKEN = "  ";
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    expect(await getCachedVaults("mainnet")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("reads a cached list back through a single GET command", async () => {
    useCredentials();
    const mockFetch = stubReply(JSON.stringify(VAULTS));

    expect(await getCachedVaults("mainnet")).toEqual(VAULTS);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(REST_URL);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(GET_MAINNET);
    // The token travels in the header, never in the URL or the body.
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${REST_TOKEN}`
    );
    expect(init.body).not.toContain(REST_TOKEN);
  });

  it("strips trailing slashes from the configured URL", async () => {
    process.env.UPSTASH_REDIS_REST_URL = `${REST_URL}/`;
    process.env.UPSTASH_REDIS_REST_TOKEN = REST_TOKEN;
    const mockFetch = stubReply("[]");

    await getCachedVaults("mainnet");

    expect(mockFetch.mock.calls[0][0]).toBe(REST_URL);
  });

  // Regression: the payload used to be JSON.stringify'd on the way in and
  // JSON.parse'd again on the way out against a client that had already
  // deserialised the reply, so a hit came back as a string rather than a list.
  it("round-trips through exactly one encode and one decode", async () => {
    useCredentials();
    const mockFetch = stubReply(JSON.stringify(VAULTS));

    await setCachedVaults("mainnet", VAULTS);
    const [, setInit] = mockFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(setInit.body).toBe(SET_MAINNET);

    // What the write put on the wire is what the read parses back. The stored
    // value is the fourth element of the SETEX command.
    const stored = JSON.parse(setInit.body as string)[3] as string;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ result: stored }), { status: 200 })
      )
    );
    expect(await getCachedVaults("mainnet")).toEqual(VAULTS);
  });

  it("writes with a Redis-side expiry so an entry cannot outlive the TTL", async () => {
    useCredentials();
    const mockFetch = stubReply("OK");

    await setCachedVaults("mainnet", VAULTS);

    const [, init] = mockFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(init.body).toBe(SET_MAINNET);
    expect(JSON.parse(init.body as string)).toEqual([
      "SETEX",
      "vault-cache:mainnet",
      60,
      JSON.stringify(VAULTS),
    ]);
  });

  it("keys the cache per network", async () => {
    useCredentials();
    const mockFetch = stubReply(JSON.stringify(VAULTS));

    await getCachedVaults("testnet");

    expect(JSON.parse(mockFetch.mock.calls[0][1].body as string)).toEqual([
      "GET",
      "vault-cache:testnet",
    ]);
  });

  it("returns null when the key is absent", async () => {
    useCredentials();
    stubReply(null);

    expect(await getCachedVaults("mainnet")).toBeNull();
  });

  it("returns null for a non-array payload rather than throwing", async () => {
    useCredentials();
    stubReply(JSON.stringify({ unexpected: true }));

    expect(await getCachedVaults("mainnet")).toBeNull();
  });

  it("returns null for an unparseable payload rather than throwing", async () => {
    useCredentials();
    stubReply("{not json");

    expect(await getCachedVaults("mainnet")).toBeNull();
  });

  it("treats an Upstash error response as a miss", async () => {
    useCredentials();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "ERR nope" }), { status: 200 })
      )
    );

    expect(await getCachedVaults("mainnet")).toBeNull();
  });

  it("reports the status, never the URL or token, when the request fails", async () => {
    useCredentials();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 }))
    );

    expect(await getCachedVaults("mainnet")).toBeNull();

    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("401");
    expect(logged).not.toContain(REST_TOKEN);
    expect(logged).not.toContain(REST_URL);
  });

  it("resolves rather than throwing when the write fails", async () => {
    useCredentials();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 }))
    );

    await expect(setCachedVaults("mainnet", VAULTS)).resolves.toBeUndefined();
  });

  it("resolves rather than throwing when the write rejects", async () => {
    useCredentials();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket hang up");
      })
    );

    await expect(setCachedVaults("mainnet", VAULTS)).resolves.toBeUndefined();
  });
});
