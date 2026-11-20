import { Address, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { withRaceTimeout } from "@meridian/shared";
import { getRpcServer } from "./internal";

const RPC_TIMEOUT_MS = 10_000;

export const VAULT_EVENT_MAX_PAGE_SIZE = 1_000;
export const VAULT_EVENT_MAX_LEDGER_RANGE = 10_000;

interface VaultEventBase {
  id: string;
  transactionHash: string;
  ledgerSequence: number;
  timestamp?: Date;
}

export type VaultEvent =
  | (VaultEventBase & {
      kind: "deposit";
      caller: string;
      amount: bigint;
      shares: bigint;
    })
  | (VaultEventBase & {
      kind: "withdraw";
      caller: string;
      shares: bigint;
      amount: bigint;
    })
  | (VaultEventBase & {
      kind: "performance_fee";
      caller: string;
      treasury: string;
      amount: bigint;
      shares: bigint;
    })
  | (VaultEventBase & { kind: "paused"; paused: boolean })
  | (VaultEventBase & { kind: "admin_transfer"; newAdmin: string })
  | (VaultEventBase & { kind: "admin_accept"; newAdmin: string })
  | (VaultEventBase & { kind: "adapter_changed"; newAdapter: string })
  | (VaultEventBase & {
      kind: "migration_started";
      newAdapter: string;
      earliestLedger: number;
    })
  | (VaultEventBase & {
      kind: "adapter_migrated";
      oldAdapter: string;
      newAdapter: string;
    })
  | (VaultEventBase & {
      kind: "unknown";
      raw: rpc.Api.EventResponse;
    });

export interface GetVaultEventsOptions {
  /** First ledger to scan. Required unless `cursor` is provided. */
  startLedger?: number;
  /** Optional inclusive upper ledger bound. */
  endLedger?: number;
  /** Cursor returned by a previous call. Mutually exclusive with ledger bounds. */
  cursor?: string;
  /** Number of events requested from RPC. Defaults to 200; maximum is 1,000. */
  pageSize?: number;
}

export interface VaultEventPage {
  events: VaultEvent[];
  latestLedger: number;
  nextCursor?: string;
}

export class VaultEventRpcError extends Error {
  readonly code = "VAULT_EVENT_RPC_ERROR";
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Soroban RPC failed while reading vault events");
    this.name = "VaultEventRpcError";
    this.cause = cause;
  }
}

function validateOptions(options: GetVaultEventsOptions): number {
  const { startLedger, endLedger, cursor, pageSize = 200 } = options;
  if (cursor && (startLedger !== undefined || endLedger !== undefined)) {
    throw new RangeError("cursor cannot be combined with ledger bounds");
  }
  if (!cursor && startLedger === undefined) {
    throw new RangeError("startLedger is required when cursor is not provided");
  }
  if (
    startLedger !== undefined &&
    (!Number.isSafeInteger(startLedger) || startLedger < 0)
  ) {
    throw new RangeError("startLedger must be a non-negative safe integer");
  }
  if (
    endLedger !== undefined &&
    (!Number.isSafeInteger(endLedger) ||
      endLedger < 0 ||
      startLedger === undefined ||
      endLedger < startLedger)
  ) {
    throw new RangeError(
      "endLedger must be a safe integer at or after startLedger"
    );
  }
  if (
    startLedger !== undefined &&
    endLedger !== undefined &&
    endLedger - startLedger > VAULT_EVENT_MAX_LEDGER_RANGE
  ) {
    throw new RangeError(
      `ledger range cannot exceed ${VAULT_EVENT_MAX_LEDGER_RANGE}`
    );
  }
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > VAULT_EVENT_MAX_PAGE_SIZE
  ) {
    throw new RangeError(
      `pageSize must be an integer between 1 and ${VAULT_EVENT_MAX_PAGE_SIZE}`
    );
  }
  return pageSize;
}

function tuple(value: xdr.ScVal): xdr.ScVal[] | null {
  if (value.switch().name !== "scvVec") return null;
  return value.vec() ?? null;
}

function address(value: xdr.ScVal | undefined): string | null {
  if (!value || value.switch().name !== "scvAddress") return null;
  try {
    return Address.fromScVal(value).toString();
  } catch {
    return null;
  }
}

function integer(value: xdr.ScVal | undefined): bigint | null {
  if (!value || value.switch().name !== "scvI128") return null;
  const decoded = scValToNative(value);
  return typeof decoded === "bigint" ? decoded : null;
}

function baseEvent(event: rpc.Api.EventResponse): VaultEventBase {
  return {
    id: event.id,
    transactionHash: event.txHash,
    ledgerSequence: event.ledger,
    ...(event.ledgerClosedAt
      ? { timestamp: new Date(event.ledgerClosedAt) }
      : {}),
  };
}

function unknownEvent(event: rpc.Api.EventResponse): VaultEvent {
  return { ...baseEvent(event), kind: "unknown", raw: event };
}

function decodeVaultEvent(event: rpc.Api.EventResponse): VaultEvent {
  const firstTopic = event.topic[0];
  if (!firstTopic || firstTopic.switch().name !== "scvSymbol") {
    return unknownEvent(event);
  }

  const topic = firstTopic.sym().toString();
  const adminAction =
    event.topic[1]?.switch().name === "scvSymbol"
      ? event.topic[1].sym().toString()
      : undefined;
  const value = event.value;
  const fields = tuple(value);
  const base = baseEvent(event);

  try {
    if (topic === "deposit" && fields?.length === 3) {
      const caller = address(fields[0]);
      const amount = integer(fields[1]);
      const shares = integer(fields[2]);
      if (caller && amount !== null && shares !== null) {
        return { ...base, kind: "deposit", caller, amount, shares };
      }
    } else if (topic === "withdraw" && fields?.length === 3) {
      const caller = address(fields[0]);
      const shares = integer(fields[1]);
      const amount = integer(fields[2]);
      if (caller && shares !== null && amount !== null) {
        return { ...base, kind: "withdraw", caller, shares, amount };
      }
    } else if (topic === "perf_fee" && fields?.length === 4) {
      const caller = address(fields[0]);
      const treasury = address(fields[1]);
      const amount = integer(fields[2]);
      const shares = integer(fields[3]);
      if (caller && treasury && amount !== null && shares !== null) {
        return {
          ...base,
          kind: "performance_fee",
          caller,
          treasury,
          amount,
          shares,
        };
      }
    } else if (topic === "admin" && adminAction === "paused") {
      if (value.switch().name === "scvBool") {
        return { ...base, kind: "paused", paused: value.b() };
      }
    } else if (
      topic === "admin" &&
      (adminAction === "transfer" || adminAction === "accept")
    ) {
      const newAdmin = address(value);
      if (newAdmin) {
        return {
          ...base,
          kind: adminAction === "transfer" ? "admin_transfer" : "admin_accept",
          newAdmin,
        };
      }
    } else if (topic === "admin" && adminAction === "adapter") {
      const newAdapter = address(value);
      if (newAdapter) {
        return { ...base, kind: "adapter_changed", newAdapter };
      }
    } else if (topic === "admin" && adminAction === "migrate") {
      if (fields?.length === 2) {
        const oldAdapter = address(fields[0]);
        const newAdapter = address(fields[1]);
        if (oldAdapter && newAdapter) {
          return { ...base, kind: "adapter_migrated", oldAdapter, newAdapter };
        }
      }
    } else if (topic === "admin" && adminAction === "mig_begin") {
      if (fields?.length === 2) {
        const newAdapter = address(fields[0]);
        const ledgerValue = fields[1]!;
        const ledger =
          ledgerValue.switch().name === "scvU32"
            ? ledgerValue.u32()
            : ledgerValue.switch().name === "scvU64"
              ? Number(ledgerValue.u64().toString())
              : null;
        if (
          newAdapter &&
          ledger !== null &&
          Number.isSafeInteger(ledger) &&
          ledger >= 0
        ) {
          return {
            ...base,
            kind: "migration_started",
            newAdapter,
            earliestLedger: ledger,
          };
        }
      }
    }
  } catch {
    return unknownEvent(event);
  }

  return unknownEvent(event);
}

/**
 * Reads one bounded page of events emitted by a vault contract. Continue
 * polling with `nextCursor`, or start a separate scan with a ledger range.
 */
export async function getVaultEvents(
  rpcUrl: string,
  vaultContractId: string,
  options: GetVaultEventsOptions
): Promise<VaultEventPage> {
  const pageSize = validateOptions(options);
  const server = getRpcServer(rpcUrl, RPC_TIMEOUT_MS);
  const filters: rpc.Api.EventFilter[] = [
    { type: "contract", contractIds: [vaultContractId] },
  ];
  const request = options.cursor
    ? { filters, cursor: options.cursor, limit: pageSize }
    : {
        filters,
        startLedger: options.startLedger!,
        ...(options.endLedger !== undefined
          ? { endLedger: options.endLedger }
          : {}),
        limit: pageSize,
      };

  try {
    const response = await withRaceTimeout(
      () => server.getEvents(request),
      RPC_TIMEOUT_MS,
      "Soroban RPC getEvents"
    );
    return {
      events: (response.events ?? []).map(decodeVaultEvent),
      latestLedger: response.latestLedger,
      ...(response.cursor ? { nextCursor: response.cursor } : {}),
    };
  } catch (error) {
    throw new VaultEventRpcError(error);
  }
}
