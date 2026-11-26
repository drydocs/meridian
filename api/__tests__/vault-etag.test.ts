import { afterEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { RouteResult } from "@meridian/api-core";

vi.mock("@meridian/api-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@meridian/api-core")>()),
  handleGetVaults: vi.fn(),
  handleGetVaultById: vi.fn(),
}));

type Route = "list" | "detail";
type Handlers = {
  list: (req: VercelRequest, res: VercelResponse) => Promise<unknown>;
  detail: (req: VercelRequest, res: VercelResponse) => Promise<unknown>;
  core: typeof import("@meridian/api-core");
};

async function loadHandlers(): Promise<Handlers> {
  // Load the mocked module first so the routes and the test share one mock.
  const core = await import("@meridian/api-core");
  const list = await import("../v1/vaults/index.js");
  const detail = await import("../v1/vaults/[vaultId].js");
  return {
    list: list.default,
    detail: detail.default,
    core,
  };
}

function fakeReq(headers: Record<string, string> = {}): VercelRequest {
  return {
    method: "GET",
    headers,
    query: { vaultId: "meridian-usdc" },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as VercelRequest;
}

interface FakeRes {
  statusCode: number;
  body: unknown;
  rawBody: string | undefined;
  headers: Record<string, string>;
  ended: boolean;
}

function fakeRes(): FakeRes & VercelResponse {
  const response: FakeRes = {
    statusCode: 200,
    body: undefined,
    rawBody: undefined,
    headers: {},
    ended: false,
  };
  return Object.assign(response, {
    status(code: number) {
      response.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      response.body = payload;
      return this;
    },
    send(payload: string) {
      response.rawBody = payload;
      response.body = JSON.parse(payload);
      return this;
    },
    end() {
      response.ended = true;
      return this;
    },
    setHeader(key: string, value: string) {
      response.headers[key] = value;
    },
  }) as unknown as FakeRes & VercelResponse;
}

function setSuccess(core: Handlers["core"], route: Route, body: unknown): void {
  const result: RouteResult = { status: 200, body };
  if (route === "list") {
    vi.mocked(core.handleGetVaults).mockResolvedValue(result);
  } else {
    vi.mocked(core.handleGetVaultById).mockResolvedValue(result);
  }
}

function requiredEtag(res: FakeRes): string {
  const etag = res.headers.ETag;
  if (!etag)
    throw new Error("Expected successful vault response to include ETag");
  return etag;
}

async function callRoute(
  handlers: Handlers,
  route: Route,
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  await handlers[route](req, res);
}

const listBody = {
  vaults: [{ id: "meridian-usdc", apy: 5 }],
  recommendedVaultId: "meridian-usdc",
  updatedAt: "2026-01-01T00:00:00.000Z",
  cached: false,
};
const detailBody = { id: "meridian-usdc", apy: 5 };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe.each(["list", "detail"] as const)("vault %s ETag", (route) => {
  it("returns a strong ETag with the full successful response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const handlers = await loadHandlers();
    const body = route === "list" ? listBody : detailBody;
    setSuccess(handlers.core, route, body);

    const res = fakeRes();
    await callRoute(handlers, route, fakeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.headers.ETag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(res.rawBody).toBe(JSON.stringify(body));
    expect(res.body).toEqual(body);
  });

  it("returns 304 with an empty body when If-None-Match matches", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const handlers = await loadHandlers();
    const body = route === "list" ? listBody : detailBody;
    setSuccess(handlers.core, route, body);

    const first = fakeRes();
    await callRoute(handlers, route, fakeReq(), first);
    const res = fakeRes();
    await callRoute(
      handlers,
      route,
      fakeReq({ "if-none-match": requiredEtag(first) }),
      res
    );

    expect(res.statusCode).toBe(304);
    expect(res.headers.ETag).toBe(first.headers.ETag);
    expect(res.headers["Cache-Control"]).toBe(first.headers["Cache-Control"]);
    expect(res.body).toBeUndefined();
    expect(res.rawBody).toBeUndefined();
    expect(res.ended).toBe(true);
  });

  it("returns the full response for a non-matching tag", async () => {
    const handlers = await loadHandlers();
    const body = route === "list" ? listBody : detailBody;
    setSuccess(handlers.core, route, body);

    const res = fakeRes();
    await callRoute(
      handlers,
      route,
      fakeReq({ "if-none-match": '"different"' }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(body);
    expect(res.rawBody).toBe(JSON.stringify(body));
  });

  it("changes the ETag when the response payload changes", async () => {
    const handlers = await loadHandlers();
    const firstBody = route === "list" ? listBody : detailBody;
    const changedBody =
      route === "list"
        ? { ...listBody, vaults: [{ id: "meridian-usdc", apy: 6 }] }
        : { ...detailBody, apy: 6 };
    setSuccess(handlers.core, route, firstBody);
    const first = fakeRes();
    await callRoute(handlers, route, fakeReq(), first);

    setSuccess(handlers.core, route, changedBody);
    const changed = fakeRes();
    await callRoute(handlers, route, fakeReq(), changed);

    expect(changed.headers.ETag).not.toBe(first.headers.ETag);
  });
});

describe("vault list ETag stability", () => {
  it("keeps the ETag when only updatedAt and cached change", async () => {
    const handlers = await loadHandlers();
    setSuccess(handlers.core, "list", listBody);
    const first = fakeRes();
    await callRoute(handlers, "list", fakeReq(), first);

    setSuccess(handlers.core, "list", {
      ...listBody,
      updatedAt: "2026-01-01T00:05:00.000Z",
      cached: true,
    });
    const res = fakeRes();
    await callRoute(
      handlers,
      "list",
      fakeReq({ "if-none-match": requiredEtag(first) }),
      res
    );

    expect(res.statusCode).toBe(304);
    expect(res.headers.ETag).toBe(first.headers.ETag);
  });

  it("still sends the full body, including updatedAt, on a 200", async () => {
    const handlers = await loadHandlers();
    setSuccess(handlers.core, "list", listBody);
    const res = fakeRes();
    await callRoute(handlers, "list", fakeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(listBody);
  });
});

describe.each(["list", "detail"] as const)(
  "testnet vault %s cache headers",
  (route) => {
    it("keeps no-store on a conditional 304", async () => {
      vi.stubEnv("STELLAR_NETWORK", "testnet");
      vi.resetModules();
      const handlers = await loadHandlers();
      setSuccess(
        handlers.core,
        route,
        route === "list" ? listBody : detailBody
      );

      const first = fakeRes();
      await callRoute(handlers, route, fakeReq(), first);
      const res = fakeRes();
      await callRoute(
        handlers,
        route,
        fakeReq({ "if-none-match": requiredEtag(first) }),
        res
      );

      expect(first.headers["Cache-Control"]).toBe("no-store");
      expect(res.statusCode).toBe(304);
      expect(res.headers["Cache-Control"]).toBe("no-store");
      expect(res.body).toBeUndefined();
    });
  }
);
