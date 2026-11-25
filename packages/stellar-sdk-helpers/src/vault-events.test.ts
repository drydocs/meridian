import { Address, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getVaultEvents,
  VAULT_EVENTS_MAX_LEDGER_RANGE,
  VAULT_EVENTS_MAX_PAGE_SIZE,
  VaultEventsRpcError,
} from "./vault-events";

const RPC_URL = "https://soroban-testnet.stellar.org";
const VAULT_ID = "CBOE7JPROCMUKQ4NJWPKCLBBQGHLTGV4X3463DHK4D7KX6KWXGZETAJL";
const CALLER = "GC7MCAT5QBXWXOUDN57SFAM3T353J7KMNVDRK4J5ZSILUJVRL7M3OUIN";

function event(topic: xdr.ScVal[], value: xdr.ScVal): rpc.Api.EventResponse {
  return {
    type: "contract",
    ledger: 123,
    ledgerClosedAt: "2026-08-27T20:00:00Z",
    id: "event-id",
    pagingToken: "cursor-1",
    topic,
    value,
    inSuccessfulContractCall: true,
    txHash: "transaction-hash",
  } as unknown as rpc.Api.EventResponse;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getVaultEvents", () => {
  it("decodes a deposit event and queries only the requested vault range", async () => {
    const getEvents = vi
      .spyOn(rpc.Server.prototype, "getEvents")
      .mockResolvedValueOnce({
        events: [
          event(
            [xdr.ScVal.scvSymbol("deposit"), xdr.ScVal.scvU32(1)],
            xdr.ScVal.scvVec([
              Address.fromString(CALLER).toScVal(),
              nativeToScVal(500n, { type: "i128" }),
              nativeToScVal(490n, { type: "i128" }),
              nativeToScVal(480n, { type: "i128" }),
            ])
          ),
        ],
        cursor: "next-cursor",
      } as never);

    const result = await getVaultEvents(RPC_URL, VAULT_ID, {
      startLedger: 100,
      endLedger: 200,
      pageSize: 50,
    });

    expect(result.events[0]).toMatchObject({
      type: "deposit",
      caller: CALLER,
      amount: "500",
      adapterSharesCredited: "490",
      sharesMinted: "480",
      ledgerSequence: 123,
      transactionHash: "transaction-hash",
      timestamp: new Date("2026-08-27T20:00:00Z"),
    });
    expect(result.nextCursor).toBe("next-cursor");
    expect(getEvents).toHaveBeenCalledWith({
      filters: [{ type: "contract", contractIds: [VAULT_ID] }],
      startLedger: 100,
      endLedger: 200,
      limit: 50,
    });
  });

  it("decodes the remaining vault and admin event payloads", async () => {
    const adminTopic = (action: string) => [
      xdr.ScVal.scvSymbol("admin"),
      xdr.ScVal.scvSymbol(action),
      xdr.ScVal.scvU32(1),
    ];
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValueOnce({
      events: [
        event(
          [xdr.ScVal.scvSymbol("withdraw"), xdr.ScVal.scvU32(1)],
          xdr.ScVal.scvVec([
            Address.fromString(CALLER).toScVal(),
            nativeToScVal(12n, { type: "i128" }),
            nativeToScVal(11n, { type: "i128" }),
          ])
        ),
        event(
          [xdr.ScVal.scvSymbol("perf_fee"), xdr.ScVal.scvU32(1)],
          xdr.ScVal.scvVec([
            Address.fromString(CALLER).toScVal(),
            Address.fromString(CALLER).toScVal(),
            nativeToScVal(3n, { type: "i128" }),
            nativeToScVal(2n, { type: "i128" }),
          ])
        ),
        event(adminTopic("paused"), xdr.ScVal.scvBool(true)),
        event(adminTopic("transfer"), Address.fromString(CALLER).toScVal()),
        event(adminTopic("accept"), Address.fromString(CALLER).toScVal()),
        event(adminTopic("adapter"), Address.fromString(CALLER).toScVal()),
        event(
          adminTopic("mig_begin"),
          xdr.ScVal.scvVec([
            Address.fromString(CALLER).toScVal(),
            nativeToScVal(17_380, { type: "u32" }),
          ])
        ),
        event(
          adminTopic("migrate"),
          xdr.ScVal.scvVec([
            Address.fromString(CALLER).toScVal(),
            Address.fromString(CALLER).toScVal(),
          ])
        ),
      ],
      cursor: "",
    } as never);

    const result = await getVaultEvents(RPC_URL, VAULT_ID, {
      startLedger: 100,
      endLedger: 200,
    });

    expect(result.events.map((record) => record.type)).toEqual([
      "withdraw",
      "performance_fee",
      "paused",
      "admin_transfer",
      "admin_accept",
      "adapter_changed",
      "migration_started",
      "migration_completed",
    ]);
    expect(result.events[0]).toMatchObject({
      type: "withdraw",
      caller: CALLER,
      shares: "12",
      usdcOut: "11",
    });
    expect(result.events[1]).toMatchObject({
      type: "performance_fee",
      fee: "3",
      treasuryShares: "2",
    });
    expect(result.events[2]).toMatchObject({ type: "paused", paused: true });
    expect(result.events[6]).toMatchObject({
      type: "migration_started",
      newAdapter: CALLER,
      earliestLedger: 17_380,
    });
    expect(result.events[7]).toMatchObject({
      type: "migration_completed",
      oldAdapter: CALLER,
      newAdapter: CALLER,
    });
  });

  it("preserves events with unknown topics as raw records", async () => {
    const raw = event(
      [xdr.ScVal.scvSymbol("future_event"), xdr.ScVal.scvU32(9)],
      xdr.ScVal.scvBool(true)
    );
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValueOnce({
      events: [raw],
      cursor: "",
    } as never);

    const result = await getVaultEvents(RPC_URL, VAULT_ID, {
      startLedger: 100,
      endLedger: 100,
    });

    expect(result.events).toEqual([
      expect.objectContaining({ type: "unknown", raw }),
    ]);
    expect(result).not.toHaveProperty("nextCursor");
  });

  it("returns an empty event list for an empty range", async () => {
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValueOnce({
      events: [],
      cursor: "",
    } as never);

    await expect(
      getVaultEvents(RPC_URL, VAULT_ID, { startLedger: 100, endLedger: 100 })
    ).resolves.toEqual({ events: [] });
  });

  it("wraps RPC failures in a typed error", async () => {
    vi.spyOn(rpc.Server.prototype, "getEvents").mockRejectedValueOnce(
      new Error("offline")
    );

    await expect(
      getVaultEvents(RPC_URL, VAULT_ID, { startLedger: 100, endLedger: 100 })
    ).rejects.toBeInstanceOf(VaultEventsRpcError);
  });

  it("uses a cursor and caps pages and ledger ranges", async () => {
    const getEvents = vi
      .spyOn(rpc.Server.prototype, "getEvents")
      .mockResolvedValueOnce({ events: [], cursor: "" } as never);
    await getVaultEvents(RPC_URL, VAULT_ID, { cursor: "page-2" });
    expect(getEvents).toHaveBeenCalledWith({
      filters: [{ type: "contract", contractIds: [VAULT_ID] }],
      cursor: "page-2",
      limit: 200,
    });

    await expect(
      getVaultEvents(RPC_URL, VAULT_ID, {
        startLedger: 1,
        endLedger: VAULT_EVENTS_MAX_LEDGER_RANGE + 1,
      })
    ).rejects.toThrow(/Ledger range cannot exceed/);
    await expect(
      getVaultEvents(RPC_URL, VAULT_ID, {
        cursor: "page-2",
        pageSize: VAULT_EVENTS_MAX_PAGE_SIZE + 1,
      })
    ).rejects.toThrow(/pageSize must be an integer/);
    expect(getEvents).toHaveBeenCalledTimes(1);
  });
});
