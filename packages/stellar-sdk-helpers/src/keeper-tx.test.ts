import { describe, expect, it, vi } from "vitest";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import {
  assertAdapterUnchanged,
  assertVaultHealthy,
  DEFAULT_FEE_ESCALATION,
  expectString,
  isDefinitiveOnChainFailure,
  isMigrationCooldownError,
  isStaleAdapterError,
  isTransientKeeperError,
  keeperFeeForAttempt,
  KeeperTransactionClient,
  KEEPER_BASE_FEE_STROOPS,
  KEEPER_MAX_FEE_STROOPS,
  MIGRATION_COOLDOWN_ERROR_TEXT,
  rawErrorText,
  StaleAdapterError,
  STALE_ADAPTER_MESSAGE,
  SubmissionFailedError,
  SubmissionInFlightError,
  submitKeeperOperation,
  TX_VALIDITY_WINDOW_MS,
  type FeeEscalationConfig,
} from "./keeper-tx";
import * as txModule from "./tx";

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      assembleTransaction: vi.fn(actual.rpc.assembleTransaction),
      Api: {
        ...actual.rpc.Api,
        isSimulationError: vi.fn(actual.rpc.Api.isSimulationError),
        isSimulationSuccess: vi.fn(actual.rpc.Api.isSimulationSuccess),
      },
    },
  };
});

vi.mock("./tx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tx")>();
  return {
    ...actual,
    simulateView: vi.fn(),
    waitForTransaction: vi.fn(),
    describeSendError: vi.fn().mockReturnValue("Describe send error"),
  };
});

describe("keeper-tx", () => {
  describe("assertVaultHealthy", () => {
    it("skips the health preflight when an older vault has no get_health method", async () => {
      vi.mocked(txModule.simulateView).mockRejectedValueOnce(
        new Error(
          "HostError: Error(WasmVm, MissingValue): " +
            "trying to invoke non-existent contract function get_health"
        )
      );
      await expect(
        assertVaultHealthy({} as never, "vault", "passphrase")
      ).resolves.toBeUndefined();
    });

    it("does not skip the preflight when get_health traps", async () => {
      const error = new Error("HostError: Error(WasmVm, InvalidAction)");
      vi.mocked(txModule.simulateView).mockRejectedValueOnce(error);
      await expect(
        assertVaultHealthy({} as never, "vault", "passphrase")
      ).rejects.toBe(error);
    });

    it("still blocks health preflight on RPC failures", async () => {
      const error = new Error("RPC request timed out");
      vi.mocked(txModule.simulateView).mockRejectedValueOnce(error);
      await expect(
        assertVaultHealthy({} as never, "vault", "passphrase")
      ).rejects.toBe(error);
    });

    it("blocks health preflight when the view reports a counter mismatch", async () => {
      vi.mocked(txModule.simulateView).mockResolvedValueOnce({
        total_shares_mismatch: true,
      });
      await expect(
        assertVaultHealthy({} as never, "vault", "passphrase")
      ).rejects.toThrow("vault health check failed: total shares mismatch");
    });
  });

  describe("constants and simple helpers", () => {
    it("exports TX_VALIDITY_WINDOW_MS", () => {
      expect(TX_VALIDITY_WINDOW_MS).toBe(300_000);
    });

    it("rawErrorText extracts message or converts to string", () => {
      expect(rawErrorText(new Error("custom error"))).toBe("custom error");
      expect(rawErrorText("plain string")).toBe("plain string");
      expect(rawErrorText(404)).toBe("404");
    });

    it("isDefinitiveOnChainFailure detects on-chain failure message", () => {
      expect(
        isDefinitiveOnChainFailure(new Error("Transaction 123 failed on-chain"))
      ).toBe(true);
      expect(isDefinitiveOnChainFailure(new Error("Timeout error"))).toBe(
        false
      );
    });

    it("isTransientKeeperError classifies errors correctly", () => {
      expect(
        isTransientKeeperError(new SubmissionFailedError("permanent"))
      ).toBe(false);
      expect(
        isTransientKeeperError(new SubmissionInFlightError("hash", "pending"))
      ).toBe(true);
      expect(isTransientKeeperError(new Error("Please try again later"))).toBe(
        true
      );
      expect(isTransientKeeperError(new Error("Request timed out"))).toBe(true);
      expect(isTransientKeeperError(new Error("Rate limit exceeded"))).toBe(
        true
      );
      expect(
        isTransientKeeperError(new Error("Service temporarily down"))
      ).toBe(true);
      expect(
        isTransientKeeperError(new Error("HTTP 429 Too Many Requests"))
      ).toBe(true);
      expect(isTransientKeeperError(new Error("Server error 500"))).toBe(true);
      expect(isTransientKeeperError(new Error("Fatal permission error"))).toBe(
        false
      );
      expect(
        isTransientKeeperError(
          new Error("Transaction rejected at submission: txInsufficientFee")
        )
      ).toBe(true);
    });

    it("isTransientKeeperError ignores status-code digits embedded in a longer number", () => {
      // A ledger sequence or amount that merely contains "503" is not a
      // status code; misreading it would retry a permanent failure forever.
      expect(isTransientKeeperError(new Error("ledger 15034 rejected"))).toBe(
        false
      );
      expect(isTransientKeeperError(new Error("amount 4290000 too low"))).toBe(
        false
      );
    });

    it("isTransientKeeperError matches every retryable status code on its own", () => {
      for (const code of [429, 500, 502, 503, 504]) {
        expect(isTransientKeeperError(new Error(`HTTP ${code}`))).toBe(true);
      }
    });

    it("isTransientKeeperError matches transient keywords regardless of case", () => {
      expect(isTransientKeeperError(new Error("Request TIMEOUT"))).toBe(true);
      expect(isTransientKeeperError(new Error("Timed Out waiting"))).toBe(true);
    });

    it("keeperFeeForAttempt doubles per attempt starting from the base fee (0-indexed)", () => {
      // attempt 0 is the first try: baseFee * multiplier^0 = baseFee
      // attempt 1 is the first retry: baseFee * multiplier^1 = 2*baseFee
      // attempt 2 is the second retry: baseFee * multiplier^2 = 4*baseFee
      expect(keeperFeeForAttempt(0, KEEPER_BASE_FEE_STROOPS)).toBe(
        KEEPER_BASE_FEE_STROOPS
      );
      expect(keeperFeeForAttempt(1, KEEPER_BASE_FEE_STROOPS)).toBe(
        KEEPER_BASE_FEE_STROOPS * 2
      );
      expect(keeperFeeForAttempt(2, KEEPER_BASE_FEE_STROOPS)).toBe(
        KEEPER_BASE_FEE_STROOPS * 4
      );
    });

    it("keeperFeeForAttempt accepts a custom base fee", () => {
      expect(keeperFeeForAttempt(0, 5000)).toBe(5000);
      expect(keeperFeeForAttempt(1, 5000)).toBe(10000);
      expect(keeperFeeForAttempt(2, 5000)).toBe(20000);
    });

    it("keeperFeeForAttempt caps the fee instead of growing unbounded at high attempt counts", () => {
      // An operator raising maxAttempts to ride out sustained congestion
      // (parsePositiveInt enforces no upper bound on it) must not turn the
      // doubling schedule into an unbounded real-money bid.
      expect(keeperFeeForAttempt(20, KEEPER_BASE_FEE_STROOPS)).toBe(
        KEEPER_MAX_FEE_STROOPS
      );
      expect(keeperFeeForAttempt(30, KEEPER_BASE_FEE_STROOPS)).toBe(
        KEEPER_MAX_FEE_STROOPS
      );
    });

    it("keeperFeeForAttempt respects a custom maxFee via FeeEscalationConfig", () => {
      const customMax = 80000;
      expect(keeperFeeForAttempt(0, 10000, { maxFee: customMax })).toBe(10000);
      expect(keeperFeeForAttempt(3, 10000, { maxFee: customMax })).toBe(80000);
      expect(keeperFeeForAttempt(4, 10000, { maxFee: customMax })).toBe(80000);
    });

    it("keeperFeeForAttempt respects a custom multiplier via FeeEscalationConfig", () => {
      expect(keeperFeeForAttempt(0, 1000, { multiplier: 3 })).toBe(1000);
      expect(keeperFeeForAttempt(1, 1000, { multiplier: 3 })).toBe(3000);
      expect(keeperFeeForAttempt(2, 1000, { multiplier: 3 })).toBe(9000);
    });

    it("keeperFeeForAttempt uses DEFAULT_FEE_ESCALATION defaults when config is omitted", () => {
      expect(DEFAULT_FEE_ESCALATION.maxFee).toBe(KEEPER_MAX_FEE_STROOPS);
      expect(DEFAULT_FEE_ESCALATION.multiplier).toBe(2);
    });

    it("KEEPER_MAX_FEE_STROOPS is exported and matches the default cap", () => {
      expect(KEEPER_MAX_FEE_STROOPS).toBe(1_000_000);
    });

    it("FeeEscalationConfig type is exported", () => {
      const config: FeeEscalationConfig = { maxFee: 50000, multiplier: 2 };
      expect(config.maxFee).toBe(50000);
      expect(config.multiplier).toBe(2);
    });

    it("keeperFeeForAttempt starts well above the network's absolute fee floor", () => {
      // The whole point of this constant: 100 stroops (the network minimum)
      // is what produced the real txInsufficientFee rejections this fix
      // addresses.
      expect(KEEPER_BASE_FEE_STROOPS).toBeGreaterThan(100);
    });

    it("isDefinitiveOnChainFailure does not match a still-unknown timeout outcome", () => {
      // Distinct from a confirmed failure: the client gave up waiting, but
      // the transaction may still land, so it must not be treated the same
      // as a confirmed on-chain failure.
      expect(
        isDefinitiveOnChainFailure(
          new Error("Timed out waiting for transaction abc123 to confirm")
        )
      ).toBe(false);
    });

    it("expectString validates strings", () => {
      expect(expectString("valid", "method", "contract")).toBe("valid");
      expect(() => expectString(123, "method", "contract")).toThrow(
        "method() on contract did not return a string (got number)"
      );
      expect(() => expectString(null, "method", "contract")).toThrow(
        "(got object)"
      );
      expect(() => expectString(undefined, "method", "contract")).toThrow(
        "(got undefined)"
      );
    });

    it("StaleAdapterError and isStaleAdapterError", () => {
      const err = new StaleAdapterError("expected", "actual");
      expect(err.message).toContain(STALE_ADAPTER_MESSAGE);
      expect(isStaleAdapterError(err)).toBe(true);
      expect(isStaleAdapterError(new Error(STALE_ADAPTER_MESSAGE))).toBe(true);
      expect(isStaleAdapterError(new Error("Other error"))).toBe(false);
    });

    it("isMigrationCooldownError", () => {
      // The real shape a simulation rejection surfaces as (see
      // MigrationCooldownNotMet = 20 in
      // packages/contracts/vault/src/errors.rs): a HostError whose first
      // line is the bare contract error code, detail (if any) further down
      // in the event log. errorMessage() only looks at that first line, so
      // this doesn't need to reproduce the full event log to match.
      expect(
        isMigrationCooldownError(
          new Error("HostError: Error(Contract, #20)\nEvent log ...")
        )
      ).toBe(true);
      expect(
        isMigrationCooldownError(new Error(MIGRATION_COOLDOWN_ERROR_TEXT))
      ).toBe(true);
      // simulateTransaction rewrites the host error through simErrorMessage
      // before it is thrown, so the cooldown skip must still match.
      expect(
        isMigrationCooldownError(
          new Error(
            `Simulation failed: ${txModule.simErrorMessage("HostError: Error(Contract, #20)")}`
          )
        )
      ).toBe(true);
      // A different contract error code must not false-positive as a
      // cooldown rejection.
      expect(
        isMigrationCooldownError(new Error("HostError: Error(Contract, #13)"))
      ).toBe(false);
      expect(isMigrationCooldownError(new Error("Other error"))).toBe(false);
    });
  });

  describe("assertAdapterUnchanged", () => {
    it("passes when live adapter matches expected", async () => {
      vi.mocked(txModule.simulateView).mockResolvedValueOnce("adapter-1");
      await expect(
        assertAdapterUnchanged(
          {} as never,
          "vault-1",
          "passphrase",
          "adapter-1"
        )
      ).resolves.toBeUndefined();
    });

    it("throws StaleAdapterError when adapter mismatches", async () => {
      vi.mocked(txModule.simulateView).mockResolvedValueOnce("adapter-2");
      await expect(
        assertAdapterUnchanged(
          {} as never,
          "vault-1",
          "passphrase",
          "adapter-1"
        )
      ).rejects.toThrow(StaleAdapterError);
    });
  });

  describe("submitKeeperOperation", () => {
    const config = {
      network: {
        network: "testnet" as const,
        rpcUrl: "https://soroban-testnet.stellar.org",
        passphrase: "Test SDF Network ; September 2015",
      },
      secretKey: "SDJVL65W4DVKN2G3V5477LSPTL2FPG35VSPM5Y4Y5W3HLSQO3542247A", // valid secret key for tests
      rpcTimeoutMs: 1000,
      confirmationTimeoutMs: 2000,
    };

    it("handles priorHash confirmed path", async () => {
      vi.mocked(txModule.waitForTransaction).mockResolvedValueOnce({
        ledger: 100,
      } as never);
      const onResolved = vi.fn();

      const res = await submitKeeperOperation(
        "contract",
        "method",
        [],
        config,
        {} as never,
        "priorHash123",
        { onResolved }
      );

      expect(res).toEqual({ hash: "priorHash123", ledger: 100 });
      expect(onResolved).toHaveBeenCalledWith("priorHash123");
    });

    it("handles priorHash on-chain failure path", async () => {
      vi.mocked(txModule.waitForTransaction).mockRejectedValueOnce(
        new Error("Transaction failed on-chain")
      );
      const onResolved = vi.fn();

      await expect(
        submitKeeperOperation(
          "contract",
          "method",
          [],
          config,
          {} as never,
          "priorHash123",
          { onResolved }
        )
      ).rejects.toThrow(SubmissionFailedError);

      expect(onResolved).toHaveBeenCalledWith("priorHash123");
    });

    it("handles priorHash in-flight error path", async () => {
      vi.mocked(txModule.waitForTransaction).mockRejectedValueOnce(
        new Error("Network timeout")
      );

      await expect(
        submitKeeperOperation(
          "contract",
          "method",
          [],
          config,
          {} as never,
          "priorHash123"
        )
      ).rejects.toThrow(SubmissionInFlightError);
    });

    describe("KeeperTransactionClient", () => {
      const signer = Keypair.random();

      function createClient(
        overrides: Partial<
          ConstructorParameters<typeof KeeperTransactionClient>[0]
        > = {}
      ) {
        return new KeeperTransactionClient({
          signer,
          server: {} as never,
          rpcTimeoutMs: 100,
          confirmationTimeoutMs: 100,
          retryPolicy: {
            maxAttempts: 3,
            baseDelayMs: 0,
            sleep: async () => {},
          },
          deadlineAt: Date.now() + 10_000,
          ...overrides,
        });
      }

      it("rebuilds on retry and escalates fees up to the configured cap", async () => {
        const fees: number[] = [];
        const client = createClient({
          feeEscalation: { baseFee: 10, maxFee: 25, multiplier: 2 },
        });

        const result = await client.submit(async (fee) => {
          fees.push(fee);
          throw new Error("txInsufficientFee");
        });

        expect(fees).toEqual([10, 20, 25]);
        expect(result).toMatchObject({ status: "retryable", attempts: 3 });
      });

      it("retries timed-out builds and stops at the retry limit", async () => {
        const buildTransaction = vi
          .fn()
          .mockRejectedValue(new Error("RPC request timed out"));
        const result = await createClient({
          retryPolicy: {
            maxAttempts: 2,
            baseDelayMs: 0,
            sleep: async () => {},
          },
        }).submit(buildTransaction);

        expect(buildTransaction).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({ status: "retryable", attempts: 2 });
      });

      it("stops retrying when the deadline would be exceeded", async () => {
        let now = 100;
        const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
        try {
          const buildTransaction = vi
            .fn()
            .mockRejectedValue(new Error("txInsufficientFee"));
          const result = await createClient({
            deadlineAt: 115,
            retryPolicy: {
              maxAttempts: 5,
              baseDelayMs: 10,
              sleep: async (ms) => {
                now += ms;
              },
            },
          }).submit(buildTransaction);

          expect(buildTransaction).toHaveBeenCalledTimes(2);
          expect(result).toMatchObject({ status: "retryable", attempts: 2 });
        } finally {
          nowSpy.mockRestore();
        }
      });

      it("returns duplicate when the RPC confirms a duplicate submission", async () => {
        const prepared = {
          sign: vi.fn(),
          hash: () => ({ toString: () => "duplicate-hash" }),
        };
        vi.mocked(rpc.assembleTransaction).mockReturnValue({
          build: () => prepared,
        } as never);
        vi.mocked(rpc.Api.isSimulationError).mockReturnValue(false);
        vi.mocked(rpc.Api.isSimulationSuccess).mockReturnValue(true);
        vi.mocked(txModule.describeSendError).mockReturnValueOnce(
          "txDuplicate"
        );
        vi.mocked(txModule.waitForTransaction).mockResolvedValueOnce({
          ledger: 42,
        } as never);
        const client = createClient({
          server: {
            simulateTransaction: vi.fn().mockResolvedValue({}),
            sendTransaction: vi.fn().mockResolvedValue({ status: "ERROR" }),
          } as never,
          retryPolicy: {
            maxAttempts: 2,
            baseDelayMs: 0,
            sleep: async () => {},
          },
        });

        const result = await client.submit(async () => ({}) as never);

        expect(result).toEqual({
          status: "duplicate",
          hash: "duplicate-hash",
          ledger: 42,
          attempts: 2,
        });
      });
      describe("configuration validation", () => {
        it.each([
          [
            "maxAttempts",
            { retryPolicy: { maxAttempts: 0, baseDelayMs: 0 } },
            "retryPolicy.maxAttempts must be a positive integer",
          ],
          [
            "baseDelayMs",
            { retryPolicy: { maxAttempts: 1, baseDelayMs: -1 } },
            "retryPolicy.baseDelayMs must be a non-negative number",
          ],
          [
            "deadlineAt",
            { deadlineAt: Number.NaN },
            "deadlineAt must be a finite timestamp",
          ],
          [
            "rpcTimeoutMs",
            { rpcTimeoutMs: 0 },
            "RPC and confirmation timeouts must be positive numbers",
          ],
          [
            "confirmationTimeoutMs",
            { confirmationTimeoutMs: -5 },
            "RPC and confirmation timeouts must be positive numbers",
          ],
          [
            "fee cap",
            { feeEscalation: { maxFee: 0, multiplier: 2 } },
            "feeEscalation must contain positive fees and a multiplier >= 1",
          ],
          [
            "fee multiplier",
            { feeEscalation: { maxFee: 100, multiplier: 0.5 } },
            "feeEscalation must contain positive fees and a multiplier >= 1",
          ],
          [
            "base fee",
            { feeEscalation: { maxFee: 100, multiplier: 2, baseFee: 0 } },
            "feeEscalation must contain positive fees and a multiplier >= 1",
          ],
        ])("rejects an invalid %s", (_name, overrides, message) => {
          expect(() => createClient(overrides as never)).toThrow(message);
        });

        it("accepts a complete fee escalation config", () => {
          expect(() =>
            createClient({
              feeEscalation: { baseFee: 10, maxFee: 100, multiplier: 2 },
            })
          ).not.toThrow();
        });
      });

      it("rejects an invalid initialAttempt", async () => {
        await expect(
          createClient().submit(async () => ({}) as never, {
            initialAttempt: -1,
          })
        ).rejects.toThrow("initialAttempt must be a non-negative integer");
      });

      it("returns terminal for an error that is not retryable", async () => {
        const result = await createClient().submit(async () => {
          throw new Error("Fatal permission error");
        });

        expect(result).toMatchObject({ status: "terminal", attempts: 1 });
      });

      it("reports a retryable deadline result when the deadline has passed", async () => {
        const result = await createClient({
          deadlineAt: Date.now() - 1,
        }).submit(async () => ({}) as never);

        expect(result).toMatchObject({ status: "retryable", attempts: 0 });
      });

      it("resolves a prior hash that has landed without rebuilding", async () => {
        vi.mocked(txModule.waitForTransaction).mockResolvedValueOnce({
          ledger: 7,
        } as never);
        const buildTransaction = vi.fn();
        const onResolved = vi.fn();

        const result = await createClient().submit(buildTransaction, {
          priorHash: "prior-hash",
          hooks: { onResolved },
        });

        expect(buildTransaction).not.toHaveBeenCalled();
        expect(onResolved).toHaveBeenCalledWith("prior-hash");
        expect(result).toEqual({
          status: "landed",
          hash: "prior-hash",
          ledger: 7,
          attempts: 1,
        });
      });

      it("reports terminal when a prior hash failed on-chain", async () => {
        vi.mocked(txModule.waitForTransaction).mockRejectedValueOnce(
          new Error("Transaction prior-hash failed on-chain")
        );
        const onResolved = vi.fn();

        const result = await createClient().submit(async () => ({}) as never, {
          priorHash: "prior-hash",
          hooks: { onResolved },
        });

        expect(onResolved).toHaveBeenCalledWith("prior-hash");
        expect(result).toMatchObject({ status: "terminal", attempts: 1 });
      });
    });
  });
});
