import { describe, expect, it, vi, beforeEach } from "vitest";
import Fastify from "fastify";

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

import { txRoute } from "../routes/tx.js";

describe("local transaction Idempotency-Key forwarding", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([
    ["deposit", handlers.deposit, { walletAddress: "W", vaultId: "V", amount: "1", riskAcknowledged: true }],
    ["withdraw", handlers.withdraw, { walletAddress: "W", vaultId: "V", shares: "1" }],
    ["add-trustline", handlers.trustline, { walletAddress: "W" }],
    ["submit", handlers.submit, { xdr: "SIGNED" }],
  ] as const)("forwards the exact header value for %s", async (action, handler, payload) => {
    const app = Fastify({ logger: false });
    app.register(txRoute, { prefix: "/tx" });
    const key = `local-${action}-exact-key`;
    await app.inject({ method: "POST", url: `/tx/${action}`, headers: { "idempotency-key": key }, payload });
    expect(handler).toHaveBeenCalledWith(payload, { idempotencyKey: key });
    await app.close();
  });
});
