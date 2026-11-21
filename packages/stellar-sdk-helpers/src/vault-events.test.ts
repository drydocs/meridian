import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getVaultEvents,
  VAULT_EVENT_MAX_LEDGER_RANGE,
  VAULT_EVENT_MAX_PAGE_SIZE,
  VaultEventRpcError,
} from "./vault-events";

const RPC_URL = "https://soroban-testnet.stellar.org";
const VAULT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const ACCOUNT = "GC7MCAT5QBXWXOUDN57SFAM3T353J7KMNVDRK4J5ZSILUJVRL7M3OUIN";
const ADAPTER = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
const NEW_ADAPTER = "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ";

function addressScVal(address: string): xdr.ScVal {
  return Address.fromString(address).toScVal();
}

function i128(value: string): xdr.ScVal {
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      hi: xdr.Int64.fromString("0"),
      lo: xdr.Uint64.fromString(value),
    })
  );
}

function event(
  topics: string[],
  value: xdr.ScVal,
  id = "event-1"
): rpc.Api.EventResponse {
  return {
    type: "contract",
    ledger: 123,
    ledgerClosedAt: "2026-08-27T20:00:00Z",
    id,
    pagingToken: id,
    topic: topics.map((topic) => xdr.ScVal.scvSymbol(topic)),
    value,
    inSuccessfulContractCall: true,
    txHash: "HASH",
  } as unknown as rpc.Api.EventResponse;
}

function mockEvents(events: rpc.Api.EventResponse[], cursor?: string) {
  return vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValueOnce({
    events,
    latestLedger: 200,
    ...(cursor ? { cursor } : {}),
  } as never);
}

afterEach(() => vi.restoreAllMocks());

describe("getVaultEvents", () => {
  it("decodes a deposit event and returns the next cursor", async () => {
    const spy = mockEvents(
      [
        event(
          ["deposit"],
          xdr.ScVal.scvVec([addressScVal(ACCOUNT), i128("500"), i128("450")])
        ),
      ],
      "next"
    );

    const result = await getVaultEvents(RPC_URL, VAULT_ID, {
      startLedger: 100,
      endLedger: 110,
      pageSize: 25,
    });

    expect(result.events).toMatchObject([
      {
        kind: "deposit",
        caller: ACCOUNT,
        amount: 500n,
        shares: 450n,
        ledgerSequence: 123,
        transactionHash: "HASH",
      },
    ]);
    expect(result.latestLedger).toBe(200);
    expect(result.nextCursor).toBe("next");
    expect(spy.mock.calls[0]![0]).toMatchObject({
      startLedger: 100,
      endLedger: 110,
      limit: 25,
      filters: [{ type: "contract", contractIds: [VAULT_ID] }],
    });
  });

  it.each([
    [
      "withdraw",
      ["withdraw"],
      xdr.ScVal.scvVec([addressScVal(ACCOUNT), i128("40"), i128("35")]),
      { kind: "withdraw", caller: ACCOUNT, shares: 40n, amount: 35n },
    ],
    [
      "pause",
      ["admin", "paused"],
      xdr.ScVal.scvBool(true),
      { kind: "paused", paused: true },
    ],
    [
      "admin transfer",
      ["admin", "transfer"],
      addressScVal(ACCOUNT),
      { kind: "admin_transfer", newAdmin: ACCOUNT },
    ],
    [
      "admin acceptance",
      ["admin", "accept"],
      addressScVal(ACCOUNT),
      { kind: "admin_accept", newAdmin: ACCOUNT },
    ],
    [
      "adapter change",
      ["admin", "adapter"],
      addressScVal(NEW_ADAPTER),
      { kind: "adapter_changed", newAdapter: NEW_ADAPTER },
    ],
    [
      "migration start",
      ["admin", "mig_begin"],
      xdr.ScVal.scvVec([addressScVal(NEW_ADAPTER), xdr.ScVal.scvU32(17380)]),
      {
        kind: "migration_started",
        newAdapter: NEW_ADAPTER,
        earliestLedger: 17380,
      },
    ],
    [
      "migration",
      ["admin", "migrate"],
      xdr.ScVal.scvVec([addressScVal(ADAPTER), addressScVal(NEW_ADAPTER)]),
      {
        kind: "adapter_migrated",
        oldAdapter: ADAPTER,
        newAdapter: NEW_ADAPTER,
      },
    ],
    [
      "performance fee",
      ["perf_fee"],
      xdr.ScVal.scvVec([
        addressScVal(ACCOUNT),
        addressScVal(NEW_ADAPTER),
        i128("12"),
        i128("10"),
      ]),
      {
        kind: "performance_fee",
        caller: ACCOUNT,
        treasury: NEW_ADAPTER,
        amount: 12n,
        shares: 10n,
      },
    ],
  ])("decodes %s events", async (_name, topics, value, expected) => {
    mockEvents([event(topics as string[], value as xdr.ScVal)]);

    const result = await getVaultEvents(RPC_URL, VAULT_ID, {
      startLedger: 100,
    });

    expect(result.events[0]).toMatchObject(expected);
  });

  it("preserves events with unknown topics as raw records", async () => {
    const raw = event(["future_event"], xdr.ScVal.scvBool(true));
    mockEvents([raw]);

    const result = await getVaultEvents(RPC_URL, VAULT_ID, {
      startLedger: 100,
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ kind: "unknown" });
    expect(result.events[0]).toHaveProperty("raw", raw);
  });

  it("returns an empty result for an empty range", async () => {
    mockEvents([]);

    await expect(
      getVaultEvents(RPC_URL, VAULT_ID, {
        startLedger: 100,
        endLedger: 100,
      })
    ).resolves.toMatchObject({ events: [], latestLedger: 200 });
  });

  it("wraps RPC failures in a typed error", async () => {
    vi.spyOn(rpc.Server.prototype, "getEvents").mockRejectedValueOnce(
      new Error("RPC unavailable")
    );

    await expect(
      getVaultEvents(RPC_URL, VAULT_ID, { startLedger: 100 })
    ).rejects.toBeInstanceOf(VaultEventRpcError);
  });

  it("uses a cursor instead of a ledger range and bounds its page size", async () => {
    const spy = mockEvents([]);

    await getVaultEvents(RPC_URL, VAULT_ID, {
      cursor: "cursor-1",
      pageSize: VAULT_EVENT_MAX_PAGE_SIZE,
    });

    const request = spy.mock.calls[0]![0] as Record<string, unknown>;
    expect(request).toMatchObject({ cursor: "cursor-1", limit: 1_000 });
    expect(request).not.toHaveProperty("startLedger");
  });

  it("rejects oversized page sizes and ledger ranges", async () => {
    await expect(
      getVaultEvents(RPC_URL, VAULT_ID, {
        startLedger: 1,
        pageSize: VAULT_EVENT_MAX_PAGE_SIZE + 1,
      })
    ).rejects.toThrow(RangeError);
    await expect(
      getVaultEvents(RPC_URL, VAULT_ID, {
        startLedger: 1,
        endLedger: 1 + VAULT_EVENT_MAX_LEDGER_RANGE + 1,
      })
    ).rejects.toThrow(RangeError);
  });

  it("rejects cursor and ledger options together", async () => {
    await expect(
      getVaultEvents(RPC_URL, VAULT_ID, {
        cursor: "cursor-1",
        startLedger: 100,
      })
    ).rejects.toThrow(/cursor cannot be combined/);
  });
});
