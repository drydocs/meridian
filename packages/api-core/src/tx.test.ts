import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@meridian/stellar-sdk-helpers", async (importOriginal) => ({
  ContractSimulationError: (
    await importOriginal<typeof import("@meridian/stellar-sdk-helpers")>()
  ).ContractSimulationError,
  MissingTrustlineError: (
    await importOriginal<typeof import("@meridian/stellar-sdk-helpers")>()
  ).MissingTrustlineError,
  TransactionOutcomeUnknownError: (
    await importOriginal<typeof import("@meridian/stellar-sdk-helpers")>()
  ).TransactionOutcomeUnknownError,
  buildDepositTx: vi.fn(async () => ({ xdr: "DEPOSIT_XDR", fee: "100" })),
  buildWithdrawTx: vi.fn(async () => ({ xdr: "WITHDRAW_XDR", fee: "100" })),
  buildAddTrustlineTx: vi.fn(async () => ({ xdr: "TRUST_XDR" })),
  submitTx: vi.fn(async () => ({ hash: "HASH" })),
  assertRequiredTrustlines: vi.fn(async () => undefined),
  quoteVaultAction: vi.fn(
    async ({ action }: { action: "deposit" | "withdraw" }) => ({
      action,
      expectedShares: action === "deposit" ? "9.5" : undefined,
      expectedAssets: action === "withdraw" ? "4.75" : undefined,
      fee: "100",
      ledger: 123,
      recommendedMinimum: action === "deposit" ? "9.4525" : "4.72625",
      slippageBps: 50,
    })
  ),
}));

vi.mock("./position-tracking", () => ({
  trackPositionHistoryUser: vi.fn(async () => undefined),
}));

import {
  handleDepositRequest,
  handleWithdrawRequest,
  handleAddTrustlineRequest,
  handleSubmitRequest,
  handleQuoteRequest,
} from "./tx";
import {
  buildDepositTx,
  buildWithdrawTx,
  buildAddTrustlineTx,
  submitTx,
  ContractSimulationError,
  assertRequiredTrustlines,
  MissingTrustlineError,
  quoteVaultAction,
  TransactionOutcomeUnknownError,
} from "@meridian/stellar-sdk-helpers";
import { trackPositionHistoryUser } from "./position-tracking";

const PUBKEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const USER_FIXABLE_MESSAGES: Record<number, string> = {
  3: "Deposits are currently paused. Try again later.",
  7: "Insufficient shares for this withdrawal.",
  15: "Withdrawal returned less USDC than your minimum. Adjust slippage and retry.",
  18: "Slippage tolerance exceeded. Adjust slippage and retry.",
};

// The per-action fallback txErrorResult passes to sanitizeTxError, which is
// what a non-Error rejection ends up producing.
const FALLBACK_MESSAGES = {
  deposit: "Failed to build deposit transaction",
  withdraw: "Failed to build withdraw transaction",
} as const;

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe.each([
  ["deposit", handleDepositRequest, buildDepositTx],
  ["withdraw", handleWithdrawRequest, buildWithdrawTx],
] as const)("%s contract rejections", (action, handler, builder) => {
  it.each([
    [18, 400, USER_FIXABLE_MESSAGES[18]],
    [15, 400, USER_FIXABLE_MESSAGES[15]],
    [3, 400, USER_FIXABLE_MESSAGES[3]],
    [7, 400, USER_FIXABLE_MESSAGES[7]],
    [
      17,
      500,
      "The adapter reported no assets while shares are still outstanding.",
    ],
    [23, 500, "The adapter did not credit any shares for this deposit."],
    [24, 500, "The vault hit a divide-by-zero in adapter accounting."],
  ] as const)(
    "returns %i as HTTP %i with a friendly message",
    async (code, status, message) => {
      const err = new ContractSimulationError(
        code,
        `HostError: Error(Contract, #${code})\nEvent log`
      );
      vi.mocked(builder).mockRejectedValueOnce(err);
      const result = await handler({
        walletAddress: PUBKEY,
        vaultId: "meridian-usdc",
        amount: "10",
        shares: "5",
        riskAcknowledged: true,
      });
      expect(result.status).toBe(status);
      if (status === 400) {
        expect(result.body).toEqual({ error: message });
      } else {
        expect(result.body).toEqual({ error: FALLBACK_MESSAGES[action] });
      }
      expect(result.error).toBe(err);
    }
  );

  it("maps user-fixable codes from generic Error messages to HTTP 400", async () => {
    const err = new Error("Simulation failed: Error(Contract, #3)");
    vi.mocked(builder).mockRejectedValueOnce(err);
    const result = await handler({
      walletAddress: PUBKEY,
      vaultId: "meridian-usdc",
      amount: "10",
      shares: "5",
      riskAcknowledged: true,
    });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: USER_FIXABLE_MESSAGES[3] });
  });

  // contractErrorCode can only read a discriminant off a ContractSimulationError
  // or an Error. Anything else — a thrown string, a null, a plain object — has
  // to fall through it rather than blow up while the response is being built.
  it.each([
    ["a thrown string", "boom"],
    ["a thrown null", null],
    ["a thrown plain object", { code: 18 }],
  ] as const)(
    "maps %s to HTTP 500 with the fallback message",
    async (_label, thrown) => {
      vi.mocked(builder).mockRejectedValueOnce(thrown);
      const result = await handler({
        walletAddress: PUBKEY,
        vaultId: "meridian-usdc",
        amount: "10",
        shares: "5",
        riskAcknowledged: true,
      });
      expect(result.status).toBe(500);
      // sanitizeTxError returns the fallback for any non-Error value.
      expect(result.body).toEqual({ error: FALLBACK_MESSAGES[action] });
      expect(result.error).toBe(thrown);
    }
  );
});

describe("handleDepositRequest", () => {
  it("uses one deadline for trustline checks and simulation together", async () => {
    vi.useFakeTimers();
    vi.mocked(assertRequiredTrustlines).mockImplementationOnce(
      () => new Promise<void>((resolve) => setTimeout(resolve, 5_000))
    );
    vi.mocked(buildDepositTx).mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ xdr: "DEPOSIT_XDR", fee: "100" }), 5_000)
        )
    );

    const resultPromise = handleDepositRequest({
      walletAddress: PUBKEY,
      vaultId: "blend-usdc-fixed",
      amount: "10",
      riskAcknowledged: true,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(buildDepositTx).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(resultPromise).resolves.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();
  });

  it("returns 400 listing the missing fields", async () => {
    const result = await handleDepositRequest({ walletAddress: PUBKEY });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error:
        "vaultId: Invalid input: expected string, received undefined; amount: Invalid input: expected string, received undefined; riskAcknowledged: Invalid input: expected true",
    });
  });

  it("rejects a deposit request missing risk acknowledgement", async () => {
    const result = await handleDepositRequest({
      walletAddress: PUBKEY,
      vaultId: "blend-usdc-fixed",
      amount: "10",
    });
    expect(result.status).toBe(400);
    expect(buildDepositTx).not.toHaveBeenCalled();
  });

  it("builds the deposit transaction and returns the XDR", async () => {
    const result = await handleDepositRequest({
      walletAddress: PUBKEY,
      vaultId: "blend-usdc-fixed",
      amount: "10",
      riskAcknowledged: true,
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ xdr: "DEPOSIT_XDR", fee: "100" });
    expect(result.error).toBeUndefined();
    expect(buildDepositTx).toHaveBeenCalledWith(
      "blend-usdc-fixed",
      PUBKEY,
      "10",
      expect.anything(),
      "9.4525"
    );
    expect(trackPositionHistoryUser).toHaveBeenCalledWith(PUBKEY);
  });

  it("passes min_shares_out when provided in deposit request", async () => {
    const result = await handleDepositRequest({
      walletAddress: PUBKEY,
      vaultId: "blend-usdc-fixed",
      amount: "10",
      min_shares_out: "9.5",
      riskAcknowledged: true,
    });
    expect(result.status).toBe(200);
    expect(buildDepositTx).toHaveBeenCalledWith(
      "blend-usdc-fixed",
      PUBKEY,
      "10",
      expect.anything(),
      "9.5"
    );
    expect(quoteVaultAction).not.toHaveBeenCalled();
  });

  it("returns an allowlisted builder error while retaining it for logging", async () => {
    const err = new Error("USDC trustline missing");
    vi.mocked(buildDepositTx).mockRejectedValueOnce(err);
    const result = await handleDepositRequest({
      walletAddress: PUBKEY,
      vaultId: "blend-usdc-fixed",
      amount: "10",
      riskAcknowledged: true,
    });
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "USDC trustline missing" });
    expect(result.error).toBe(err);
    expect(trackPositionHistoryUser).not.toHaveBeenCalled();
  });
});

describe("handleWithdrawRequest", () => {
  it("returns 400 when shares is missing", async () => {
    const result = await handleWithdrawRequest({
      walletAddress: PUBKEY,
      vaultId: "v",
    });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: "shares: Invalid input: expected string, received undefined",
    });
  });

  it("builds the withdraw transaction, defaulting min_usdc_out to the quote minimum", async () => {
    const result = await handleWithdrawRequest({
      walletAddress: PUBKEY,
      vaultId: "blend-usdc-fixed",
      shares: "5",
    });
    expect(result.body).toEqual({ xdr: "WITHDRAW_XDR", fee: "100" });
    expect(buildWithdrawTx).toHaveBeenCalledWith(
      "blend-usdc-fixed",
      PUBKEY,
      "5",
      expect.anything(),
      "4.72625"
    );
    expect(trackPositionHistoryUser).toHaveBeenCalledWith(PUBKEY);
  });

  it("forwards an explicit min_usdc_out to buildWithdrawTx", async () => {
    await handleWithdrawRequest({
      walletAddress: PUBKEY,
      vaultId: "blend-usdc-fixed",
      shares: "5",
      min_usdc_out: "4.9",
    });
    expect(buildWithdrawTx).toHaveBeenCalledWith(
      "blend-usdc-fixed",
      PUBKEY,
      "5",
      expect.anything(),
      "4.9"
    );
    expect(quoteVaultAction).not.toHaveBeenCalled();
  });

  it("hides internal builder errors from the caller while retaining them for logging", async () => {
    const err = new Error("withdraw failed");
    vi.mocked(buildWithdrawTx).mockRejectedValueOnce(err);
    const result = await handleWithdrawRequest({
      walletAddress: PUBKEY,
      vaultId: "blend-usdc-fixed",
      shares: "5",
    });
    expect(result.status).toBe(500);
    expect(result.body).toEqual({
      error: "Failed to build withdraw transaction",
    });
    expect(result.error).toBe(err);
    expect(trackPositionHistoryUser).not.toHaveBeenCalled();
  });
});

describe("trustline pre-validation", () => {
  it("returns 400 for deposit when USDC trustline is missing", async () => {
    vi.mocked(assertRequiredTrustlines).mockRejectedValueOnce(
      new MissingTrustlineError(["USDC"])
    );
    const result = await handleDepositRequest({
      walletAddress: PUBKEY,
      vaultId: "blend-usdc-fixed",
      amount: "10",
      riskAcknowledged: true,
    });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error:
        "Missing USDC trustline. Add the trustline via POST /api/v1/tx/add-trustline before depositing or withdrawing.",
    });
    expect(buildDepositTx).not.toHaveBeenCalled();
  });

  it("returns 400 for withdraw when USDC trustline is missing", async () => {
    vi.mocked(assertRequiredTrustlines).mockRejectedValueOnce(
      new MissingTrustlineError(["USDC"])
    );
    const result = await handleWithdrawRequest({
      walletAddress: PUBKEY,
      vaultId: "blend-usdc-fixed",
      shares: "5",
    });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error:
        "Missing USDC trustline. Add the trustline via POST /api/v1/tx/add-trustline before depositing or withdrawing.",
    });
    expect(buildWithdrawTx).not.toHaveBeenCalled();
  });

  it("checks trustlines before building a deposit", async () => {
    await handleDepositRequest({
      walletAddress: PUBKEY,
      vaultId: "blend-usdc-fixed",
      amount: "10",
      riskAcknowledged: true,
    });
    expect(assertRequiredTrustlines).toHaveBeenCalledWith(
      PUBKEY,
      expect.anything()
    );
  });
});

describe("handleAddTrustlineRequest", () => {
  it("returns 400 without a wallet address", async () => {
    const result = await handleAddTrustlineRequest({});
    expect(result.status).toBe(400);
  });

  it("returns the trustline XDR", async () => {
    const result = await handleAddTrustlineRequest({ walletAddress: PUBKEY });
    expect(result.body).toEqual({ xdr: "TRUST_XDR" });
  });

  it("hides builder errors from the caller while retaining them for logging", async () => {
    const err = new Error("trustline build failed");
    vi.mocked(buildAddTrustlineTx).mockRejectedValueOnce(err);
    const result = await handleAddTrustlineRequest({ walletAddress: PUBKEY });
    expect(result.status).toBe(500);
    expect(result.body).toEqual({
      error: "Failed to build trustline transaction",
    });
    expect(result.error).toBe(err);
  });
});

describe("handleSubmitRequest", () => {
  it("returns 400 without an xdr", async () => {
    const result = await handleSubmitRequest({});
    expect(result.status).toBe(400);
  });

  it("submits and returns the tx hash", async () => {
    const result = await handleSubmitRequest({ xdr: "SIGNED" });
    expect(result.body).toEqual({ hash: "HASH" });
  });

  it("returns a distinct outcome-unknown response with the accepted hash", async () => {
    vi.mocked(submitTx).mockResolvedValueOnce({
      hash: "HASH",
      status: "PENDING",
    } as Awaited<ReturnType<typeof submitTx>>);
    const result = await handleSubmitRequest({ xdr: "SIGNED" });
    expect(result.status).toBe(202);
    expect(result.body).toEqual({
      hash: "HASH",
      status: "PENDING",
    });
    expect(submitTx).toHaveBeenCalledWith("SIGNED", expect.anything(), {
      timeoutMs: expect.any(Number),
    });
  });

  it("does not race signed submission against the upstream request deadline", async () => {
    vi.useFakeTimers();
    let resolveSubmission!: (
      result: Awaited<ReturnType<typeof submitTx>>
    ) => void;
    vi.mocked(submitTx).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSubmission = resolve;
        })
    );

    const response = handleSubmitRequest({ xdr: "SIGNED" });
    await vi.advanceTimersByTimeAsync(8_001);
    expect(submitTx).toHaveBeenCalledOnce();

    resolveSubmission({
      hash: "HASH",
      status: "PENDING",
    } as Awaited<ReturnType<typeof submitTx>>);
    await expect(response).resolves.toMatchObject({
      status: 202,
      body: { hash: "HASH", status: "PENDING" },
    });
  });

  it("includes the hash when the RPC submission times out ambiguously", async () => {
    vi.mocked(submitTx).mockRejectedValueOnce(
      new TransactionOutcomeUnknownError("HASH")
    );
    const result = await handleSubmitRequest({ xdr: "SIGNED" });
    expect(result.status).toBe(202);
    expect(result.body).toEqual({
      hash: "HASH",
      status: "OUTCOME_UNKNOWN",
      code: "TRANSACTION_OUTCOME_UNKNOWN",
    });
  });

  it("hides submit errors from the caller while retaining them for logging", async () => {
    const err = new Error("submit failed");
    vi.mocked(submitTx).mockRejectedValueOnce(err);
    const result = await handleSubmitRequest({ xdr: "SIGNED" });
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "Failed to submit transaction" });
    expect(result.error).toBe(err);
  });

  it("maps user-fixable contract codes on submit to HTTP 400", async () => {
    const err = new ContractSimulationError(
      18,
      "HostError: Error(Contract, #18)"
    );
    vi.mocked(submitTx).mockRejectedValueOnce(err);
    const result = await handleSubmitRequest({ xdr: "SIGNED" });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: USER_FIXABLE_MESSAGES[18] });
  });
});

describe("handleQuoteRequest", () => {
  it("quotes a deposit with the default slippage minimum", async () => {
    const result = await handleQuoteRequest({
      action: "deposit",
      walletAddress: PUBKEY,
      vaultId: "blend-usdc-fixed",
      amount: "10",
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      action: "deposit",
      expectedShares: "9.5",
      recommendedMinimum: "9.4525",
      slippageBps: 50,
    });
  });

  it("quotes a withdrawal and returns expected assets", async () => {
    const result = await handleQuoteRequest({
      action: "withdraw",
      walletAddress: PUBKEY,
      vaultId: "blend-usdc-fixed",
      shares: "5",
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      action: "withdraw",
      expectedAssets: "4.75",
      recommendedMinimum: "4.72625",
      slippageBps: 50,
    });
  });

  it("rejects missing deposit or withdrawal amounts", async () => {
    expect(
      (
        await handleQuoteRequest({
          action: "deposit",
          walletAddress: PUBKEY,
          vaultId: "v",
        })
      ).status
    ).toBe(400);
    expect(
      (
        await handleQuoteRequest({
          action: "withdraw",
          walletAddress: PUBKEY,
          vaultId: "v",
        })
      ).status
    ).toBe(400);
  });

  it("maps paused and simulation failures clearly", async () => {
    vi.mocked(quoteVaultAction).mockRejectedValueOnce(
      new Error("Deposits are currently paused")
    );
    expect(
      (
        await handleQuoteRequest({
          action: "deposit",
          walletAddress: PUBKEY,
          vaultId: "v",
          amount: "10",
        })
      ).body
    ).toEqual({ error: "Deposits are currently paused" });

    vi.mocked(quoteVaultAction).mockRejectedValueOnce(
      new Error("simulation failed")
    );
    expect(
      (
        await handleQuoteRequest({
          action: "withdraw",
          walletAddress: PUBKEY,
          vaultId: "v",
          shares: "5",
        })
      ).status
    ).toBe(500);
  });
});
