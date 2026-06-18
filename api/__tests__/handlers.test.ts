import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub the workspace builders/readers — these tests exercise the HTTP handler
// contract (method guards, field validation, status codes, payload shape), not
// the Soroban transaction building, which is unit-tested in the helpers package.
vi.mock("@meridian/stellar-sdk-helpers", () => ({
  buildBlendDepositTx: vi.fn(async () => ({ xdr: "DEPOSIT_XDR", fee: "100" })),
  buildBlendWithdrawTx: vi.fn(async () => ({ xdr: "WITHDRAW_XDR", fee: "100" })),
  blendAssetForVault: vi.fn(() => "usdc"),
  resolveProtocol: vi.fn(() => "Blend"),
  toStroops: vi.fn(() => 100_000_000n),
  buildAddTrustlineTx: vi.fn(async () => ({ xdr: "TRUST_XDR" })),
  submitTx: vi.fn(async () => ({ hash: "HASH" })),
  fetchAllVaults: vi.fn(async () => [{ id: "blend-usdc-fixed", protocol: "blend" }]),
  fetchPosition: vi.fn(async () => [
    { vaultId: "v", shares: 1, deposited: 1, earned: 0, entryTime: 0 },
  ]),
}));

import depositHandler from "../v1/tx/deposit";
import withdrawHandler from "../v1/tx/withdraw";
import trustlineHandler from "../v1/tx/add-trustline";
import submitHandler from "../v1/tx/submit";
import vaultsHandler from "../v1/vaults/index";
import positionsHandler from "../v1/positions/[publicKey]";
import { buildBlendDepositTx, fetchPosition } from "@meridian/stellar-sdk-helpers";

// A 56-char Stellar public key shape (only the length is validated).
const PUBKEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

interface FakeRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
  setHeader(key: string, value: string): void;
}

function makeRes(): FakeRes {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader(key, value) {
      this.headers[key] = value;
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/v1/tx/deposit", () => {
  it("rejects non-POST methods with 405", async () => {
    const res = makeRes();
    await depositHandler({ method: "GET", body: {} }, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns 400 listing the missing fields", async () => {
    const res = makeRes();
    await depositHandler({ method: "POST", body: { walletAddress: PUBKEY } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "Missing required fields: vaultId, amount" });
  });

  it("builds the deposit transaction and returns the XDR", async () => {
    const res = makeRes();
    await depositHandler(
      { method: "POST", body: { walletAddress: PUBKEY, vaultId: "blend-usdc-fixed", amount: "10" } },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ xdr: "DEPOSIT_XDR", fee: "100" });
    expect(buildBlendDepositTx).toHaveBeenCalledOnce();
  });

  it("surfaces builder errors as 500", async () => {
    vi.mocked(buildBlendDepositTx).mockRejectedValueOnce(new Error("USDC trustline missing"));
    const res = makeRes();
    await depositHandler(
      { method: "POST", body: { walletAddress: PUBKEY, vaultId: "blend-usdc-fixed", amount: "10" } },
      res
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "USDC trustline missing" });
  });
});

describe("POST /api/v1/tx/withdraw", () => {
  it("returns 400 when the amount is missing", async () => {
    const res = makeRes();
    await withdrawHandler({ method: "POST", body: { walletAddress: PUBKEY, vaultId: "v" } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "Missing required fields: amount" });
  });

  it("builds the withdraw transaction", async () => {
    const res = makeRes();
    await withdrawHandler(
      { method: "POST", body: { walletAddress: PUBKEY, vaultId: "blend-usdc-fixed", amount: "5" } },
      res
    );
    expect(res.body).toEqual({ xdr: "WITHDRAW_XDR", fee: "100" });
  });
});

describe("POST /api/v1/tx/add-trustline", () => {
  it("returns 400 without a wallet address", async () => {
    const res = makeRes();
    await trustlineHandler({ method: "POST", body: {} }, res);
    expect(res.statusCode).toBe(400);
  });

  it("returns the trustline XDR", async () => {
    const res = makeRes();
    await trustlineHandler({ method: "POST", body: { walletAddress: PUBKEY } }, res);
    expect(res.body).toEqual({ xdr: "TRUST_XDR" });
  });
});

describe("POST /api/v1/tx/submit", () => {
  it("returns 400 without an xdr", async () => {
    const res = makeRes();
    await submitHandler({ method: "POST", body: {} }, res);
    expect(res.statusCode).toBe(400);
  });

  it("submits and returns the tx hash", async () => {
    const res = makeRes();
    await submitHandler({ method: "POST", body: { xdr: "SIGNED" } }, res);
    expect(res.body).toEqual({ hash: "HASH" });
  });
});

describe("GET /api/v1/vaults", () => {
  it("returns the vault list with a CDN cache header", async () => {
    const res = makeRes();
    await vaultsHandler({ method: "GET" }, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toContain("s-maxage=60");
    expect(res.body).toMatchObject({ vaults: [{ id: "blend-usdc-fixed" }], cached: false });
  });
});

describe("GET /api/v1/positions/:publicKey", () => {
  it("rejects a malformed public key with 400", async () => {
    const res = makeRes();
    await positionsHandler({ method: "GET", query: { publicKey: "too-short" } }, res);
    expect(res.statusCode).toBe(400);
    expect(fetchPosition).not.toHaveBeenCalled();
  });

  it("returns the resolved positions for a valid key", async () => {
    const res = makeRes();
    await positionsHandler({ method: "GET", query: { publicKey: PUBKEY } }, res);
    expect(res.body).toEqual({
      positions: [{ vaultId: "v", shares: 1, deposited: 1, earned: 0, entryTime: 0 }],
    });
    expect(fetchPosition).toHaveBeenCalledOnce();
  });

  it("degrades to an empty list if the read throws", async () => {
    vi.mocked(fetchPosition).mockRejectedValueOnce(new Error("rpc down"));
    const res = makeRes();
    await positionsHandler({ method: "GET", query: { publicKey: PUBKEY } }, res);
    expect(res.body).toEqual({ positions: [] });
  });
});
