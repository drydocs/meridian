import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const handlers = vi.hoisted(() => ({
  deposit: vi.fn(async () => ({ status: 200, body: {} })),
  withdraw: vi.fn(async () => ({ status: 200, body: {} })),
  trustline: vi.fn(async () => ({ status: 200, body: {} })),
  submit: vi.fn(async () => ({ status: 200, body: {} })),
}));
vi.mock("@meridian/api-core", () => ({
  handleDepositRequest: handlers.deposit,
  handleWithdrawRequest: handlers.withdraw,
  handleAddTrustlineRequest: handlers.trustline,
  handleSubmitRequest: handlers.submit,
}));
vi.mock("../_lib/middleware.js", () => ({
  applyCors: vi.fn(() => false),
  checkRateLimit: vi.fn(async () => true),
}));

import handler from "../v1/tx/[action]";

function response() {
  const res = { statusCode: 200, body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  return res as unknown as VercelResponse;
}

describe("Vercel transaction Idempotency-Key forwarding", () => {
  it.each([
    ["deposit", handlers.deposit, { walletAddress: "W", vaultId: "V", amount: "1", riskAcknowledged: true }],
    ["withdraw", handlers.withdraw, { walletAddress: "W", vaultId: "V", shares: "1" }],
    ["add-trustline", handlers.trustline, { walletAddress: "W" }],
    ["submit", handlers.submit, { xdr: "SIGNED" }],
  ] as const)("forwards the exact header value for %s", async (action, coreHandler, body) => {
    vi.clearAllMocks();
    const key = `vercel-${action}-exact-key`;
    const req = { method: "POST", query: { action }, headers: { "idempotency-key": key }, body } as unknown as VercelRequest;
    await handler(req, response());
    expect(coreHandler).toHaveBeenCalledWith(body, { idempotencyKey: key });
  });
});
