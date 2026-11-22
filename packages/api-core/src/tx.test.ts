import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockNetworkSubmissions = vi.hoisted(() => ({ count: 0 }));
const mockBuildNetworks = vi.hoisted(() => [] as string[]);
const mockSubmissionAttempts = vi.hoisted(() => [] as string[]);
const mockSubmissionNetworks = vi.hoisted(() => [] as string[]);
const appNetwork = vi.hoisted(() => ({
  network: "mainnet",
  rpcUrl: "",
  passphrase: "",
}));

vi.mock("@meridian/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@meridian/shared")>();
  return { ...actual, APP_NETWORK: appNetwork };
});

vi.mock("@meridian/stellar-sdk-helpers", async (importOriginal) => ({
  ContractSimulationError: (
    await importOriginal<typeof import("@meridian/stellar-sdk-helpers")>()
  ).ContractSimulationError,
  getTransactionForReconciliation: vi.fn(async () => {
    throw new Error("transaction reconciliation RPC unavailable");
  }),
  MissingTrustlineError: (
    await importOriginal<typeof import("@meridian/stellar-sdk-helpers")>()
  ).MissingTrustlineError,
  TransactionFailedError: (
    await importOriginal<typeof import("@meridian/stellar-sdk-helpers")>()
  ).TransactionFailedError,
  TransactionSubmissionRejectedError: (
    await importOriginal<typeof import("@meridian/stellar-sdk-helpers")>()
  ).TransactionSubmissionRejectedError,
  TransactionTryAgainLaterError: (
    await importOriginal<typeof import("@meridian/stellar-sdk-helpers")>()
  ).TransactionTryAgainLaterError,
  TransactionConfirmationTimeoutError: (
    await importOriginal<typeof import("@meridian/stellar-sdk-helpers")>()
  ).TransactionConfirmationTimeoutError,
  SorobanTimeoutError: (
    await importOriginal<typeof import("@meridian/stellar-sdk-helpers")>()
  ).SorobanTimeoutError,
  buildDepositTx: vi.fn(async () => ({ xdr: "DEPOSIT_XDR", fee: "100" })),
  buildWithdrawTx: vi.fn(async () => ({ xdr: "WITHDRAW_XDR", fee: "100" })),
  buildAddTrustlineTx: vi.fn(async (_walletAddress: string, network: { network: string }) => {
    mockBuildNetworks.push(network.network);
    return { xdr: "TRUST_XDR" };
  }),
  submitTx: vi.fn(async (_xdr: string, _network: unknown, options?: {
    beforeSubmit?: (identity: unknown) => Promise<void>;
  }) => {
    mockSubmissionAttempts.push((_network as { network: string }).network);
    if (options?.beforeSubmit) {
      await options.beforeSubmit({
        network: "testnet",
        transactionHash: "a".repeat(64),
        signedXdr: "SIGNED",
        sourceAccount: "G_SOURCE",
        sequence: "42",
        maxTime: "2000",
        maxLedger: null,
        submissionStartLedger: 100,
      });
    }
    mockNetworkSubmissions.count += 1;
    mockSubmissionNetworks.push((_network as { network: string }).network);
    return { hash: "a".repeat(64), status: "SUCCESS", ledger: 101 };
  }),
  inspectSubmissionXdr: vi.fn(() => ({
    network: "testnet",
    transactionHash: "a".repeat(64),
    signedXdr: "SIGNED",
    sourceAccount: "G_SOURCE",
    sequence: "42",
    maxTime: "2000",
    maxLedger: null,
  })),
  assertRequiredTrustlines: vi.fn(async () => undefined),
}));

vi.mock("./position-tracking", () => ({
  trackPositionHistoryUser: vi.fn(async () => undefined),
}));

import {
  handleDepositRequest,
  handleWithdrawRequest,
  handleAddTrustlineRequest,
  handleSubmitRequest,
} from "./tx";
import {
  buildDepositTx,
  buildWithdrawTx,
  buildAddTrustlineTx,
  submitTx,
  ContractSimulationError,
  TransactionFailedError,
  TransactionSubmissionRejectedError,
  TransactionTryAgainLaterError,
  TransactionConfirmationTimeoutError,
  SorobanTimeoutError,
  getTransactionForReconciliation,
  assertRequiredTrustlines,
  MissingTrustlineError,
} from "@meridian/stellar-sdk-helpers";
import { trackPositionHistoryUser } from "./position-tracking";
import {
  createInMemoryIdempotencyStore,
  beginIdempotentSubmission,
  hashValidatedRequest,
  type IdempotencyStore,
} from "./idempotency";
import { STELLAR_NETWORKS } from "@meridian/shared";

const originalNetwork = process.env.STELLAR_NETWORK === "testnet"
  ? "testnet"
  : "mainnet";

function useNetwork(network: "mainnet" | "testnet") {
  Object.assign(appNetwork, STELLAR_NETWORKS[network]);
}

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

const SUBMISSION_HASH = "a".repeat(64);
const UNKNOWN_SUBMISSION = {
  network: "testnet",
  transactionHash: SUBMISSION_HASH,
  signedXdr: "SIGNED",
  sourceAccount: "G_SOURCE",
  sequence: "42",
  maxTime: "2000",
  maxLedger: null,
  submissionStartLedger: 100,
};

async function seedUnknownSubmission(
  store: IdempotencyStore,
  idempotencyKey: string
) {
  return beginIdempotentSubmission({
    store,
    key: `meridian:tx:${appNetwork.network}:submit:${hashValidatedRequest(idempotencyKey)}`,
    validatedRequest: { xdr: "SIGNED" },
    submission: UNKNOWN_SUBMISSION,
  });
}

function reconciliationResponse(
  status: "SUCCESS" | "FAILED" | "NOT_FOUND",
  overrides: Record<string, unknown> = {}
) {
  return {
    status,
    txHash: SUBMISSION_HASH,
    latestLedger: 120,
    latestLedgerCloseTime: 2_001,
    oldestLedger: 50,
    oldestLedgerCloseTime: 1_900,
    ledger: 110,
    createdAt: 2_000,
    applicationOrder: 1,
    feeBump: false,
    events: { txEvents: [], contractEvents: [] },
    ...overrides,
  } as Awaited<ReturnType<typeof getTransactionForReconciliation>>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNetworkSubmissions.count = 0;
  mockBuildNetworks.length = 0;
  mockSubmissionAttempts.length = 0;
  mockSubmissionNetworks.length = 0;
  useNetwork(originalNetwork);
});

afterEach(() => useNetwork(originalNetwork));

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
      }, { store: createInMemoryIdempotencyStore() });
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
    }, { store: createInMemoryIdempotencyStore() });
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
      }, { store: createInMemoryIdempotencyStore() });
      expect(result.status).toBe(500);
      // sanitizeTxError returns the fallback for any non-Error value.
      expect(result.body).toEqual({ error: FALLBACK_MESSAGES[action] });
      expect(result.error).toBe(thrown);
    }
  );
});

describe("handleDepositRequest", () => {
  it("isolates identical keyed builds between Mainnet and Testnet", async () => {
    const store = createInMemoryIdempotencyStore();
    const body = { walletAddress: PUBKEY };
    const options = { idempotencyKey: "cross-network-build", store };

    useNetwork("mainnet");
    const mainnet = await handleAddTrustlineRequest(body, options);
    const mainnetReplay = await handleAddTrustlineRequest(body, options);
    useNetwork("testnet");
    const testnet = await handleAddTrustlineRequest(body, options);
    const testnetReplay = await handleAddTrustlineRequest(body, options);

    expect(mainnetReplay).toEqual(mainnet);
    expect(testnetReplay).toEqual(testnet);
    expect(buildAddTrustlineTx).toHaveBeenCalledTimes(2);
    expect(mockBuildNetworks).toEqual(["mainnet", "testnet"]);
  });

  it.each([
    ["deposit", handleDepositRequest, { walletAddress: PUBKEY, vaultId: "blend-usdc-fixed", amount: "10", riskAcknowledged: true }, { walletAddress: PUBKEY, vaultId: "blend-usdc-fixed", amount: "11", riskAcknowledged: true }, buildDepositTx],
    ["withdraw", handleWithdrawRequest, { walletAddress: PUBKEY, vaultId: "blend-usdc-fixed", shares: "5", riskAcknowledged: true }, { walletAddress: PUBKEY, vaultId: "blend-usdc-fixed", shares: "6", riskAcknowledged: true }, buildWithdrawTx],
    ["trustline", handleAddTrustlineRequest, { walletAddress: PUBKEY }, { walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" }, buildAddTrustlineTx],
  ] as const)("replays %s build responses and conflicts on a changed request", async (_name, handler, body, changedBody, builder) => {
    const store = createInMemoryIdempotencyStore();
    const first = await handler(body, { idempotencyKey: "build-key", store });
    const replay = await handler(body, { idempotencyKey: "build-key", store });
    const conflict = await handler(changedBody, { idempotencyKey: "build-key", store });
    expect(first).toMatchObject({ status: 200 });
    expect(replay).toEqual(first);
    expect(conflict.status).toBe(409);
    expect(builder).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["deposit", handleDepositRequest, buildDepositTx, { walletAddress: PUBKEY, vaultId: "blend-usdc-fixed", amount: "10", riskAcknowledged: true }, { walletAddress: PUBKEY, vaultId: "blend-usdc-fixed", amount: "11", riskAcknowledged: true }],
    ["withdraw", handleWithdrawRequest, buildWithdrawTx, { walletAddress: PUBKEY, vaultId: "blend-usdc-fixed", shares: "5", riskAcknowledged: true }, { walletAddress: PUBKEY, vaultId: "blend-usdc-fixed", shares: "6", riskAcknowledged: true }],
    ["add-trustline", handleAddTrustlineRequest, buildAddTrustlineTx, { walletAddress: PUBKEY }, { walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" }],
  ] as const)("uses the validated request as the fallback key for unkeyed %s requests", async (_name, handler, builder, body, differentBody) => {
    const store = createInMemoryIdempotencyStore();
    const first = await handler(body, { store });
    const replay = await handler(body, { store });
    const different = await handler(differentBody, { store });
    expect(replay).toEqual(first);
    expect(different.status).toBe(200);
    expect(builder).toHaveBeenCalledTimes(2);
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
    }, { store: createInMemoryIdempotencyStore() });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ xdr: "DEPOSIT_XDR", fee: "100" });
    expect(result.error).toBeUndefined();
    expect(buildDepositTx).toHaveBeenCalledWith(
      "blend-usdc-fixed",
      PUBKEY,
      "10",
      expect.anything(),
      "0"
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
    }, { store: createInMemoryIdempotencyStore() });
    expect(result.status).toBe(200);
    expect(buildDepositTx).toHaveBeenCalledWith(
      "blend-usdc-fixed",
      PUBKEY,
      "10",
      expect.anything(),
      "9.5"
    );
  });

  it("returns an allowlisted builder error while retaining it for logging", async () => {
    const err = new Error("USDC trustline missing");
    vi.mocked(buildDepositTx).mockRejectedValueOnce(err);
    const result = await handleDepositRequest({
      walletAddress: PUBKEY,
      vaultId: "blend-usdc-fixed",
      amount: "10",
      riskAcknowledged: true,
    }, { store: createInMemoryIdempotencyStore() });
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

  it("builds the withdraw transaction, defaulting min_usdc_out to 0", async () => {
    const result = await handleWithdrawRequest({
      walletAddress: PUBKEY,
      vaultId: "blend-usdc-fixed",
      shares: "5",
    }, { store: createInMemoryIdempotencyStore() });
    expect(result.body).toEqual({ xdr: "WITHDRAW_XDR", fee: "100" });
    expect(buildWithdrawTx).toHaveBeenCalledWith(
      "blend-usdc-fixed",
      PUBKEY,
      "5",
      expect.anything(),
      "0"
    );
    expect(trackPositionHistoryUser).toHaveBeenCalledWith(PUBKEY);
  });

  it("forwards an explicit min_usdc_out to buildWithdrawTx", async () => {
    await handleWithdrawRequest({
      walletAddress: PUBKEY,
      vaultId: "blend-usdc-fixed",
      shares: "5",
      min_usdc_out: "4.9",
    }, { store: createInMemoryIdempotencyStore() });
    expect(buildWithdrawTx).toHaveBeenCalledWith(
      "blend-usdc-fixed",
      PUBKEY,
      "5",
      expect.anything(),
      "4.9"
    );
  });

  it("hides internal builder errors from the caller while retaining them for logging", async () => {
    const err = new Error("withdraw failed");
    vi.mocked(buildWithdrawTx).mockRejectedValueOnce(err);
    const result = await handleWithdrawRequest({
      walletAddress: PUBKEY,
      vaultId: "blend-usdc-fixed",
      shares: "5",
    }, { store: createInMemoryIdempotencyStore() });
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
    }, { store: createInMemoryIdempotencyStore() });
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
    }, { store: createInMemoryIdempotencyStore() });
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
    }, { store: createInMemoryIdempotencyStore() });
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
    const result = await handleAddTrustlineRequest(
      { walletAddress: PUBKEY },
      { store: createInMemoryIdempotencyStore() }
    );
    expect(result.body).toEqual({ xdr: "TRUST_XDR" });
  });

  it("hides builder errors from the caller while retaining them for logging", async () => {
    const err = new Error("trustline build failed");
    vi.mocked(buildAddTrustlineTx).mockRejectedValueOnce(err);
    const result = await handleAddTrustlineRequest(
      { walletAddress: PUBKEY },
      { store: createInMemoryIdempotencyStore() }
    );
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
    const result = await handleSubmitRequest({ xdr: "SIGNED" }, {
      idempotencyKey: "client-key",
      store: createInMemoryIdempotencyStore(),
    });
    expect(result.body).toEqual({ hash: "a".repeat(64) });
  });

  it("persists identity before sending and replays without another send", async () => {
    const store = createInMemoryIdempotencyStore();
    const options = { idempotencyKey: "client-key", store };
    const first = await handleSubmitRequest({ xdr: "SIGNED" }, options);
    const replay = await handleSubmitRequest({ xdr: "SIGNED" }, options);

    expect(first.status).toBe(200);
    expect(replay).toEqual(first);
    expect(mockNetworkSubmissions.count).toBe(1);
    const key = `meridian:tx:${appNetwork.network}:submit:${hashValidatedRequest("client-key")}`;
    expect((await store.get(key))?.record.state).toBe("completed");
  });

  it("replays a completed response before any submit RPC work", async () => {
    const store = createInMemoryIdempotencyStore();
    const options = { idempotencyKey: "preflight-completed", store };
    const original = await handleSubmitRequest({ xdr: "SIGNED" }, options);
    vi.mocked(submitTx).mockClear();

    const replay = await handleSubmitRequest({ xdr: "SIGNED" }, options);

    expect(replay).toEqual(original);
    expect(submitTx).not.toHaveBeenCalled();
    expect(mockNetworkSubmissions.count).toBe(1);
  });

  it("reconciles an unknown outcome before latest-ledger lookup or resubmission", async () => {
    const store = createInMemoryIdempotencyStore();
    await seedUnknownSubmission(store, "preflight-unknown");
    vi.mocked(getTransactionForReconciliation).mockResolvedValueOnce(
      reconciliationResponse("SUCCESS")
    );

    const result = await handleSubmitRequest({ xdr: "SIGNED" }, {
      idempotencyKey: "preflight-unknown",
      store,
    });

    expect(result).toEqual({ status: 200, body: { hash: SUBMISSION_HASH } });
    expect(getTransactionForReconciliation).toHaveBeenCalledTimes(1);
    expect(submitTx).not.toHaveBeenCalled();
    expect(mockNetworkSubmissions.count).toBe(0);
  });

  it("fails closed when preflight storage is unavailable", async () => {
    const memory = createInMemoryIdempotencyStore();
    const store: IdempotencyStore = {
      ...memory,
      async get() {
        throw new Error("storage read unavailable");
      },
    };

    const result = await handleSubmitRequest({ xdr: "SIGNED" }, { store });

    expect(result.status).toBe(503);
    expect(submitTx).not.toHaveBeenCalled();
    expect(mockNetworkSubmissions.count).toBe(0);
  });

  it("fails closed on a malformed preflight record instead of treating it as new", async () => {
    const memory = createInMemoryIdempotencyStore();
    const store: IdempotencyStore = {
      ...memory,
      async get() {
        return {
          record: { state: "completed", requestHash: "bad" },
          revision: "malformed",
        } as never;
      },
    };

    const result = await handleSubmitRequest({ xdr: "SIGNED" }, { store });

    expect(result.status).toBe(503);
    expect(submitTx).not.toHaveBeenCalled();
    expect(mockNetworkSubmissions.count).toBe(0);
  });

  it("persists an unknown submission before the mock sends it", async () => {
    const store = createInMemoryIdempotencyStore();
    const idempotencyKey = "preflight-new-submission";
    const key = `meridian:tx:${appNetwork.network}:submit:${hashValidatedRequest(idempotencyKey)}`;
    vi.mocked(submitTx).mockImplementationOnce(async (_xdr, _network, options) => {
      await options?.beforeSubmit?.({
        network: "testnet",
        transactionHash: SUBMISSION_HASH,
        signedXdr: "SIGNED",
        sourceAccount: "G_SOURCE",
        sequence: "42",
        maxTime: "2000",
        maxLedger: null,
        submissionStartLedger: 100,
      });
      expect((await store.get(key))?.record.state).toBe("outcome_unknown");
      mockNetworkSubmissions.count += 1;
      return { hash: SUBMISSION_HASH, status: "SUCCESS", ledger: 101 };
    });

    const result = await handleSubmitRequest({ xdr: "SIGNED" }, {
      idempotencyKey,
      store,
    });

    expect(result.status).toBe(200);
    expect(mockNetworkSubmissions.count).toBe(1);
  });

  it("isolates identical keyed submissions between Mainnet and Testnet", async () => {
    const store = createInMemoryIdempotencyStore();
    const body = { xdr: "SIGNED" };
    const options = { idempotencyKey: "cross-network-submit", store };

    useNetwork("mainnet");
    const mainnet = await handleSubmitRequest(body, options);
    const mainnetReplay = await handleSubmitRequest(body, options);
    useNetwork("testnet");
    const testnet = await handleSubmitRequest(body, options);
    const testnetReplay = await handleSubmitRequest(body, options);

    expect(mainnetReplay).toEqual(mainnet);
    expect(testnetReplay).toEqual(testnet);
    expect(mockNetworkSubmissions.count).toBe(2);
    // Preflight returns completed replays before entering submitTx, so only
    // the first request for each network reaches the helper.
    expect(mockSubmissionAttempts).toEqual(["mainnet", "testnet"]);
    expect(mockSubmissionNetworks).toEqual(["mainnet", "testnet"]);
  });

  it("does not submit when outcome_unknown persistence cannot be confirmed", async () => {
    const memory = createInMemoryIdempotencyStore();
    const store: IdempotencyStore = {
      ...memory,
      async markOutcomeUnknown() {
        throw new Error("Redis write unavailable");
      },
      async get() {
        throw new Error("Redis read unavailable");
      },
    };

    const result = await handleSubmitRequest({ xdr: "SIGNED" }, {
      idempotencyKey: "unavailable-key",
      store,
    });

    expect(result.status).toBe(503);
    expect(mockNetworkSubmissions.count).toBe(0);
  });

  it("leaves an ambiguous submission outcome unknown and returns retryable status", async () => {
    const store = createInMemoryIdempotencyStore();
    vi.mocked(submitTx).mockImplementationOnce(async (_xdr, _network, options) => {
      await options?.beforeSubmit?.({
        network: "testnet",
        transactionHash: "a".repeat(64),
        signedXdr: "SIGNED",
        sourceAccount: "G_SOURCE",
        sequence: "42",
        maxTime: "2000",
        maxLedger: null,
        submissionStartLedger: 100,
      });
      mockNetworkSubmissions.count += 1;
      throw new Error("submission timed out");
    });

    const result = await handleSubmitRequest({ xdr: "SIGNED" }, {
      idempotencyKey: "client-key",
      store,
    });

    expect(result.status).toBe(503);
    expect(mockNetworkSubmissions.count).toBe(1);
    const key = `meridian:tx:${appNetwork.network}:submit:${hashValidatedRequest("client-key")}`;
    expect((await store.get(key))?.record.state).toBe("outcome_unknown");
  });

  it.each([
    [
      "submission rejection",
      () => new TransactionSubmissionRejectedError("rejected"),
    ],
    ["TRY_AGAIN_LATER", () => new TransactionTryAgainLaterError()],
    ["RPC timeout", () => new SorobanTimeoutError(10)],
    [
      "confirmation timeout",
      () => new TransactionConfirmationTimeoutError("a".repeat(64)),
    ],
  ] as const)("preserves unknown state after %s", async (_label, makeError) => {
    const store = createInMemoryIdempotencyStore();
    vi.mocked(submitTx).mockImplementationOnce(async (_xdr, _network, options) => {
      await options?.beforeSubmit?.({
        network: "testnet",
        transactionHash: "a".repeat(64),
        signedXdr: "SIGNED",
        sourceAccount: "G_SOURCE",
        sequence: "42",
        maxTime: "2000",
        maxLedger: null,
        submissionStartLedger: 100,
      });
      mockNetworkSubmissions.count += 1;
      throw makeError();
    });

    const result = await handleSubmitRequest({ xdr: "SIGNED" }, {
      idempotencyKey: "uncertain-status",
      store,
    });

    expect(result.status).toBe(503);
    const key = `meridian:tx:${appNetwork.network}:submit:${hashValidatedRequest("uncertain-status")}`;
    expect((await store.get(key))?.record.state).toBe("outcome_unknown");
  });

  it("persists a confirmed on-chain failure as completed", async () => {
    const store = createInMemoryIdempotencyStore();
    vi.mocked(submitTx).mockImplementationOnce(async (_xdr, _network, options) => {
      await options?.beforeSubmit?.({
        network: "testnet",
        transactionHash: "a".repeat(64),
        signedXdr: "SIGNED",
        sourceAccount: "G_SOURCE",
        sequence: "42",
        maxTime: "2000",
        maxLedger: null,
        submissionStartLedger: 100,
      });
      throw new TransactionFailedError("a".repeat(64));
    });

    const result = await handleSubmitRequest({ xdr: "SIGNED" }, {
      idempotencyKey: "failed-key",
      store,
    });

    expect(result.status).toBe(500);
    const key = `meridian:tx:${appNetwork.network}:submit:${hashValidatedRequest("failed-key")}`;
    expect((await store.get(key))?.record).toMatchObject({
      state: "completed",
      resolution: "FAILED",
    });
  });

  it("reconciles a retried unknown submission to confirmed SUCCESS", async () => {
    const store = createInMemoryIdempotencyStore();
    await seedUnknownSubmission(store, "reconcile-success");
    vi.mocked(getTransactionForReconciliation).mockResolvedValueOnce(
      reconciliationResponse("SUCCESS")
    );

    const result = await handleSubmitRequest({ xdr: "SIGNED" }, {
      idempotencyKey: "reconcile-success",
      store,
    });

    expect(result).toEqual({ status: 200, body: { hash: SUBMISSION_HASH } });
    expect(getTransactionForReconciliation).toHaveBeenCalledWith(
      SUBMISSION_HASH,
      expect.objectContaining({ network: "testnet" })
    );
    expect(mockNetworkSubmissions.count).toBe(0);
    const key = `meridian:tx:${appNetwork.network}:submit:${hashValidatedRequest("reconcile-success")}`;
    expect((await store.get(key))?.record).toMatchObject({
      state: "completed",
      resolution: "SUCCESS",
    });
  });

  it("reconciles a retried unknown submission to confirmed FAILED", async () => {
    const store = createInMemoryIdempotencyStore();
    await seedUnknownSubmission(store, "reconcile-failed");
    vi.mocked(getTransactionForReconciliation).mockResolvedValueOnce(
      reconciliationResponse("FAILED")
    );

    const result = await handleSubmitRequest({ xdr: "SIGNED" }, {
      idempotencyKey: "reconcile-failed",
      store,
    });

    expect(result).toEqual({
      status: 500,
      body: { error: "Failed to submit transaction" },
    });
    expect(mockNetworkSubmissions.count).toBe(0);
    const key = `meridian:tx:${appNetwork.network}:submit:${hashValidatedRequest("reconcile-failed")}`;
    expect((await store.get(key))?.record).toMatchObject({
      state: "completed",
      resolution: "FAILED",
    });
  });

  it("expires an unknown submission only after validity and RPC history close", async () => {
    const store = createInMemoryIdempotencyStore();
    await seedUnknownSubmission(store, "reconcile-expired");
    vi.mocked(getTransactionForReconciliation).mockResolvedValueOnce(
      reconciliationResponse("NOT_FOUND")
    );

    const result = await handleSubmitRequest({ xdr: "SIGNED" }, {
      idempotencyKey: "reconcile-expired",
      store,
    });

    expect(result).toEqual({
      status: 410,
      body: {
        error:
          "Transaction expired without being found in retained RPC history. Prepare and sign a new transaction.",
      },
    });
    const key = `meridian:tx:${appNetwork.network}:submit:${hashValidatedRequest("reconcile-expired")}`;
    expect((await store.get(key))?.record).toMatchObject({
      state: "completed",
      resolution: "EXPIRED",
    });
  });

  it("retains an unknown submission when the reconciliation RPC fails", async () => {
    const store = createInMemoryIdempotencyStore();
    await seedUnknownSubmission(store, "reconcile-rpc-outage");
    vi.mocked(getTransactionForReconciliation).mockRejectedValueOnce(
      new Error("RPC unavailable")
    );

    const result = await handleSubmitRequest({ xdr: "SIGNED" }, {
      idempotencyKey: "reconcile-rpc-outage",
      store,
    });

    expect(result.status).toBe(503);
    expect(mockNetworkSubmissions.count).toBe(0);
    const key = `meridian:tx:${appNetwork.network}:submit:${hashValidatedRequest("reconcile-rpc-outage")}`;
    expect((await store.get(key))?.record.state).toBe("outcome_unknown");
  });

  it.each([
    ["an unknown status", { status: "PENDING" }],
    ["a missing status", { status: undefined }],
    ["a malformed status", { status: 42 }],
    ["a missing transaction hash", { txHash: undefined }],
    ["a malformed transaction hash", { txHash: 42 }],
    ["a mismatched SUCCESS hash", { status: "SUCCESS", txHash: "b".repeat(64) }],
    ["a mismatched FAILED hash", { status: "FAILED", txHash: "b".repeat(64) }],
  ] as const)("retains an unknown submission for %s RPC evidence", async (_label, overrides) => {
    const store = createInMemoryIdempotencyStore();
    await seedUnknownSubmission(store, "reconcile-invalid-evidence");
    vi.mocked(getTransactionForReconciliation).mockResolvedValueOnce(
      reconciliationResponse("NOT_FOUND", overrides)
    );

    const result = await handleSubmitRequest({ xdr: "SIGNED" }, {
      idempotencyKey: "reconcile-invalid-evidence",
      store,
    });

    expect(result.status).toBe(503);
    expect(mockNetworkSubmissions.count).toBe(0);
    const key = `meridian:tx:${appNetwork.network}:submit:${hashValidatedRequest("reconcile-invalid-evidence")}`;
    expect((await store.get(key))?.record.state).toBe("outcome_unknown");
  });

  it("retains an unknown submission while validity is still open", async () => {
    const store = createInMemoryIdempotencyStore();
    await seedUnknownSubmission(store, "reconcile-open");
    vi.mocked(getTransactionForReconciliation).mockResolvedValueOnce(
      reconciliationResponse("NOT_FOUND", {
        latestLedgerCloseTime: 1_999,
      })
    );

    const result = await handleSubmitRequest({ xdr: "SIGNED" }, {
      idempotencyKey: "reconcile-open",
      store,
    });

    expect(result.status).toBe(503);
    expect(mockNetworkSubmissions.count).toBe(0);
    const key = `meridian:tx:${appNetwork.network}:submit:${hashValidatedRequest("reconcile-open")}`;
    expect((await store.get(key))?.record.state).toBe("outcome_unknown");
  });

  it("retains an unknown submission when RPC history misses the submission ledger", async () => {
    const store = createInMemoryIdempotencyStore();
    await seedUnknownSubmission(store, "reconcile-incomplete-history");
    vi.mocked(getTransactionForReconciliation).mockResolvedValueOnce(
      reconciliationResponse("NOT_FOUND", { oldestLedger: 101 })
    );

    const result = await handleSubmitRequest({ xdr: "SIGNED" }, {
      idempotencyKey: "reconcile-incomplete-history",
      store,
    });

    expect(result.status).toBe(503);
    expect(mockNetworkSubmissions.count).toBe(0);
    const key = `meridian:tx:${appNetwork.network}:submit:${hashValidatedRequest("reconcile-incomplete-history")}`;
    expect((await store.get(key))?.record.state).toBe("outcome_unknown");
  });

  it("allows concurrent retries to reconcile once without resubmitting", async () => {
    const store = createInMemoryIdempotencyStore();
    await seedUnknownSubmission(store, "reconcile-concurrent");
    vi.mocked(getTransactionForReconciliation).mockResolvedValue(
      reconciliationResponse("SUCCESS")
    );
    const options = { idempotencyKey: "reconcile-concurrent", store };

    const results = await Promise.all([
      handleSubmitRequest({ xdr: "SIGNED" }, options),
      handleSubmitRequest({ xdr: "SIGNED" }, options),
    ]);

    expect(results).toEqual([
      { status: 200, body: { hash: SUBMISSION_HASH } },
      { status: 200, body: { hash: SUBMISSION_HASH } },
    ]);
    expect(getTransactionForReconciliation).toHaveBeenCalledTimes(2);
    expect(mockNetworkSubmissions.count).toBe(0);
  });

  it("hides submit errors from the caller while retaining them for logging", async () => {
    const err = new Error("submit failed");
    vi.mocked(submitTx).mockRejectedValueOnce(err);
    const result = await handleSubmitRequest({ xdr: "SIGNED" }, {
      store: createInMemoryIdempotencyStore(),
    });
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
    const result = await handleSubmitRequest({ xdr: "SIGNED" }, {
      store: createInMemoryIdempotencyStore(),
    });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: USER_FIXABLE_MESSAGES[18] });
  });
});
