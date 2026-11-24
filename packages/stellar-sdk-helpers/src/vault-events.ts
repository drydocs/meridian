import { Address, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

export const VAULT_EVENTS_DEFAULT_PAGE_SIZE = 200;
export const VAULT_EVENTS_MAX_PAGE_SIZE = 1_000;
export const VAULT_EVENTS_MAX_LEDGER_RANGE = 100_000;

interface VaultEventBase {
  id: string;
  ledgerSequence: number;
  transactionHash: string;
  timestamp?: Date;
}

export type VaultEvent =
  | (VaultEventBase & {
      type: "deposit";
      caller: string;
      amount: string;
      adapterSharesCredited: string;
      sharesMinted: string;
    })
  | (VaultEventBase & {
      type: "withdraw";
      caller: string;
      shares: string;
      usdcOut: string;
    })
  | (VaultEventBase & {
      type: "performance_fee";
      caller: string;
      treasury: string;
      fee: string;
      treasuryShares: string;
    })
  | (VaultEventBase & { type: "paused"; paused: boolean })
  | (VaultEventBase & { type: "admin_transfer"; newAdmin: string })
  | (VaultEventBase & { type: "admin_accept"; newAdmin: string })
  | (VaultEventBase & { type: "adapter_changed"; newAdapter: string })
  | (VaultEventBase & {
      type: "migration_started";
      newAdapter: string;
      earliestLedger: number;
    })
  | (VaultEventBase & {
      type: "migration_completed";
      oldAdapter: string;
      newAdapter: string;
    })
  | (VaultEventBase & {
      type: "unknown";
      raw: rpc.Api.EventResponse;
    });

export interface VaultEventsPage {
  events: VaultEvent[];
  nextCursor?: string;
}

export type GetVaultEventsOptions =
  | {
      startLedger: number;
      endLedger: number;
      cursor?: never;
      pageSize?: number;
    }
  | {
      cursor: string;
      startLedger?: never;
      endLedger?: never;
      pageSize?: number;
    };

export class VaultEventsRpcError extends Error {
  readonly code = "VAULT_EVENTS_RPC_ERROR";
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Failed to fetch vault events from Soroban RPC");
    this.name = "VaultEventsRpcError";
    this.cause = cause;
  }
}

/**
 * Fetches one bounded page of events for a vault. Start-ledger requests must
 * specify an inclusive range; subsequent pages can be read with `nextCursor`.
 */
export async function getVaultEvents(
  rpcUrl: string,
  vaultContractId: string,
  options: GetVaultEventsOptions
): Promise<VaultEventsPage> {
  const pageSize = options.pageSize ?? VAULT_EVENTS_DEFAULT_PAGE_SIZE;
  if (
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > VAULT_EVENTS_MAX_PAGE_SIZE
  ) {
    throw new RangeError(
      `pageSize must be an integer between 1 and ${VAULT_EVENTS_MAX_PAGE_SIZE}`
    );
  }

  const server = new rpc.Server(rpcUrl);
  const filters: rpc.Api.EventFilter[] = [
    { type: "contract", contractIds: [vaultContractId] },
  ];

  let request: rpc.Api.GetEventsRequest;
  if (options.cursor !== undefined) {
    request = {
      filters,
      cursor: options.cursor,
      limit: pageSize,
    };
  } else {
    const { startLedger, endLedger } = options;
    if (
      !Number.isSafeInteger(startLedger) ||
      !Number.isSafeInteger(endLedger) ||
      startLedger < 1 ||
      endLedger < startLedger
    ) {
      throw new RangeError("Invalid vault event ledger range");
    }
    if (endLedger - startLedger + 1 > VAULT_EVENTS_MAX_LEDGER_RANGE) {
      throw new RangeError(
        `Ledger range cannot exceed ${VAULT_EVENTS_MAX_LEDGER_RANGE} ledgers`
      );
    }
    request = {
      filters,
      startLedger,
      endLedger,
      limit: pageSize,
    };
  }

  let response: rpc.Api.GetEventsResponse;
  try {
    response = await server.getEvents(request);
  } catch (error) {
    throw new VaultEventsRpcError(error);
  }

  const events = (response.events ?? []).map(parseVaultEvent);
  return {
    events,
    ...(response.cursor ? { nextCursor: response.cursor } : {}),
  };
}

function parseVaultEvent(event: rpc.Api.EventResponse): VaultEvent {
  const base: VaultEventBase = {
    id: event.id,
    ledgerSequence: event.ledger,
    transactionHash: event.txHash,
    ...(event.ledgerClosedAt
      ? { timestamp: new Date(event.ledgerClosedAt) }
      : {}),
  };
  const topics = event.topic;
  const first = topicSymbol(topics[0]);
  const isAdminEvent = first === "admin";
  const action = topicSymbol(topics[isAdminEvent ? 1 : 0]);
  const schemaVersion = topics[isAdminEvent ? 2 : 1];
  const legacy = isAdminEvent ? topics.length === 2 : topics.length === 1;
  if (
    !action ||
    (!legacy &&
      (topics.length !== (isAdminEvent ? 3 : 2) ||
        !schemaVersion ||
        schemaVersion.switch().name !== "scvU32" ||
        schemaVersion.u32() !== 1))
  ) {
    return { ...base, type: "unknown", raw: event };
  }

  const value = event.value;
  const values = value.switch().name === "scvVec" ? value.vec() : null;

  if (!isAdminEvent) {
    if (!values) return { ...base, type: "unknown", raw: event };
    switch (action) {
      case "deposit": {
        const [caller, amount, credited, minted] = values;
        const parsedCaller = caller && parseAddress(caller);
        const parsedAmount = amount && parseInteger(amount);
        const parsedCredited = credited && parseInteger(credited);
        const parsedMinted = minted && parseInteger(minted);
        if (parsedCaller && parsedAmount && parsedCredited && parsedMinted) {
          return {
            ...base,
            type: "deposit",
            caller: parsedCaller,
            amount: parsedAmount,
            adapterSharesCredited: parsedCredited,
            sharesMinted: parsedMinted,
          };
        }
        break;
      }
      case "withdraw": {
        const [caller, shares, amount] = values;
        const parsedCaller = caller && parseAddress(caller);
        const parsedShares = shares && parseInteger(shares);
        const parsedAmount = amount && parseInteger(amount);
        if (parsedCaller && parsedShares && parsedAmount) {
          return {
            ...base,
            type: "withdraw",
            caller: parsedCaller,
            shares: parsedShares,
            usdcOut: parsedAmount,
          };
        }
        break;
      }
      case "perf_fee": {
        const [caller, treasury, fee, shares] = values;
        const parsedCaller = caller && parseAddress(caller);
        const parsedTreasury = treasury && parseAddress(treasury);
        const parsedFee = fee && parseInteger(fee);
        const parsedShares = shares && parseInteger(shares);
        if (parsedCaller && parsedTreasury && parsedFee && parsedShares) {
          return {
            ...base,
            type: "performance_fee",
            caller: parsedCaller,
            treasury: parsedTreasury,
            fee: parsedFee,
            treasuryShares: parsedShares,
          };
        }
        break;
      }
    }
    return { ...base, type: "unknown", raw: event };
  }

  switch (action) {
    case "paused":
      if (value.switch().name === "scvBool") {
        return { ...base, type: "paused", paused: value.b() };
      }
      break;
    case "transfer":
    case "accept": {
      const newAdmin = parseAddress(value);
      if (newAdmin) {
        return {
          ...base,
          type: action === "transfer" ? "admin_transfer" : "admin_accept",
          newAdmin,
        };
      }
      break;
    }
    case "adapter": {
      const newAdapter = parseAddress(value);
      if (newAdapter) {
        return { ...base, type: "adapter_changed", newAdapter };
      }
      break;
    }
    case "mig_begin": {
      const [adapter, ledger] = values ?? [];
      const newAdapter = adapter && parseAddress(adapter);
      const earliestLedger = ledger && parseLedger(ledger);
      if (
        newAdapter &&
        earliestLedger !== null &&
        earliestLedger !== undefined
      ) {
        return {
          ...base,
          type: "migration_started",
          newAdapter,
          earliestLedger,
        };
      }
      break;
    }
    case "migrate": {
      const [old, next] = values ?? [];
      const oldAdapter = old && parseAddress(old);
      const newAdapter = next && parseAddress(next);
      if (oldAdapter && newAdapter) {
        return {
          ...base,
          type: "migration_completed",
          oldAdapter,
          newAdapter,
        };
      }
      break;
    }
  }
  return { ...base, type: "unknown", raw: event };
}

function topicSymbol(topic: xdr.ScVal | undefined): string | null {
  return topic?.switch().name === "scvSymbol" ? topic.sym().toString() : null;
}

function parseAddress(value: xdr.ScVal): string | null {
  if (value.switch().name !== "scvAddress") return null;
  try {
    return Address.fromScVal(value).toString();
  } catch {
    return null;
  }
}

function parseInteger(value: xdr.ScVal): string | null {
  const type = value.switch().name;
  if (
    type !== "scvI128" &&
    type !== "scvU128" &&
    type !== "scvI64" &&
    type !== "scvU64" &&
    type !== "scvU32"
  ) {
    return null;
  }
  const native = scValToNative(value);
  return typeof native === "bigint" || typeof native === "number"
    ? native.toString()
    : null;
}

function parseLedger(value: xdr.ScVal): number | null {
  if (value.switch().name !== "scvU32" && value.switch().name !== "scvU64") {
    return null;
  }
  const parsed = parseInteger(value);
  if (parsed === null) return null;
  const ledger = Number(parsed);
  return Number.isSafeInteger(ledger) ? ledger : null;
}
