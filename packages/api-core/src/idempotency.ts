import { createHash, randomUUID } from "node:crypto";

export const DEFAULT_IDEMPOTENCY_RESULT_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_IDEMPOTENCY_LEASE_TTL_MS = 5 * 60 * 1_000;
export const DEFAULT_IDEMPOTENCY_RENEWAL_INTERVAL_MS = 60 * 1_000;

export interface IdempotencyResponse {
  status: number;
  body: unknown;
}

export interface ProcessingIdempotencyRecord {
  state: "processing";
  requestHash: string;
  ownerToken: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CompletedIdempotencyRecord {
  state: "completed";
  requestHash: string;
  ownerToken: string;
  response: IdempotencyResponse;
  completedAtMs: number;
  resolution?: "SUCCESS" | "FAILED" | "EXPIRED";
}

export interface SubmissionIdentity {
  network: string;
  transactionHash: string;
  signedXdr: string;
  sourceAccount: string;
  sequence: string;
  /** Decimal Unix seconds; null means no finite time upper bound. */
  maxTime: string | null;
  /** Exclusive upper ledger bound; null means no finite ledger upper bound. */
  maxLedger: number | null;
  /** Latest ledger observed before the first send, when available. */
  submissionStartLedger?: number;
}

export interface UnknownSubmissionRecord {
  state: "outcome_unknown";
  requestHash: string;
  ownerToken: string;
  transactionHash: string;
  signedXdr: string;
  network: string;
  sourceAccount: string;
  sequence: string;
  maxTime: string | null;
  maxLedger: number | null;
  submissionStartLedger: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export type IdempotencyRecord =
  | ProcessingIdempotencyRecord
  | UnknownSubmissionRecord
  | CompletedIdempotencyRecord;

export interface StoredIdempotencyRecord {
  record: IdempotencyRecord;
  /** Exact stored bytes used for owner-checked compare-and-set operations. */
  revision: string;
}

/**
 * Redis-independent storage contract. A successful claim uses SET NX
 * semantics; renew and finalize must compare both ownerToken and revision.
 */
export interface IdempotencyStore {
  get(key: string): Promise<StoredIdempotencyRecord | null>;
  claim(
    key: string,
    record: ProcessingIdempotencyRecord,
    leaseTtlMs: number
  ): Promise<StoredIdempotencyRecord | null>;
  renew(
    key: string,
    ownerToken: string,
    expectedRevision: string,
    updatedAtMs: number,
    leaseTtlMs: number
  ): Promise<StoredIdempotencyRecord | null>;
  finalize(
    key: string,
    ownerToken: string,
    expectedRevision: string,
    record: CompletedIdempotencyRecord,
    resultTtlMs: number
  ): Promise<StoredIdempotencyRecord | null>;
  /** Atomically replace a processing lease with a persistent unknown outcome. */
  markOutcomeUnknown(
    key: string,
    ownerToken: string,
    expectedRevision: string,
    record: UnknownSubmissionRecord
  ): Promise<StoredIdempotencyRecord | null>;
  /** Atomically resolve an unknown transaction into a TTL-bound terminal result. */
  resolveOutcomeUnknown(
    key: string,
    ownerToken: string,
    expectedRevision: string,
    record: CompletedIdempotencyRecord,
    resultTtlMs: number
  ): Promise<StoredIdempotencyRecord | null>;
}

export type IdempotencyResult =
  | { kind: "executed"; response: IdempotencyResponse }
  | { kind: "replayed"; response: IdempotencyResponse }
  | { kind: "conflict" }
  | { kind: "in-progress" }
  | { kind: "unavailable" };

export type SubmissionClaimResult =
  | { kind: "ready"; record: UnknownSubmissionRecord }
  | { kind: "replayed"; response: IdempotencyResponse }
  | { kind: "outcome-unknown"; record: UnknownSubmissionRecord }
  | { kind: "in-progress" }
  | { kind: "conflict" }
  | { kind: "unavailable" };

export type SubmissionObservation =
  | { kind: "SUCCESS"; transactionHash: string; response: IdempotencyResponse }
  | { kind: "FAILED"; transactionHash: string; response: IdempotencyResponse }
  | {
      kind: "NOT_FOUND";
      transactionHash: string;
      latestLedger: number;
      latestLedgerCloseTime: string;
      oldestLedger: number;
      expiredResponse: IdempotencyResponse;
    }
  | { kind: "RPC_TIMEOUT" | "TRY_AGAIN_LATER" | "REDIS_UNCERTAIN" };

export type SubmissionReconciliationResult =
  | {
      kind: "completed";
      resolution: "SUCCESS" | "FAILED" | "EXPIRED";
      response: IdempotencyResponse;
    }
  | { kind: "outcome-unknown"; record: UnknownSubmissionRecord }
  | { kind: "observation-mismatch" }
  | { kind: "unavailable" };

export interface RunIdempotentlyOptions {
  store: IdempotencyStore;
  key: string;
  /** Pass the parsed, validated request value, including schema defaults. */
  validatedRequest: unknown;
  execute: (signal: AbortSignal) => Promise<IdempotencyResponse>;
  leaseTtlMs?: number;
  renewalIntervalMs?: number;
  resultTtlMs?: number;
  now?: () => number;
  ownerToken?: () => string;
}

/**
 * Hash a validated request after recursively sorting object keys. Callers
 * must pass schema output, never the unvalidated HTTP body.
 */
export function hashValidatedRequest(value: unknown): string {
  const canonical = JSON.stringify(canonicalize(value));
  if (canonical === undefined) {
    throw new TypeError("Validated request is not JSON serializable");
  }
  return createHash("sha256").update(canonical).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Validated request contains a non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Validated request must contain plain objects");
    }
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, canonicalize(source[key])])
    );
  }
  throw new TypeError("Validated request contains a non-JSON value");
}

/**
 * Claims a key before running the operation, renews the processing lease,
 * then persists the original status and body before reporting success.
 * Throws from execute deliberately leave the claim in place: callers cannot
 * know whether a transaction submission took effect and must not release it.
 */
/** Idempotency wrapper for non-transaction operations only. Signed
 * transaction submission must use beginIdempotentSubmission instead. */
export async function runNonTransactionIdempotently(
  options: RunIdempotentlyOptions
): Promise<IdempotencyResult> {
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_IDEMPOTENCY_LEASE_TTL_MS;
  const renewalIntervalMs =
    options.renewalIntervalMs ?? DEFAULT_IDEMPOTENCY_RENEWAL_INTERVAL_MS;
  const resultTtlMs =
    options.resultTtlMs ?? DEFAULT_IDEMPOTENCY_RESULT_TTL_MS;
  assertPositiveTtl(leaseTtlMs, "leaseTtlMs");
  assertPositiveTtl(resultTtlMs, "resultTtlMs");
  if (!Number.isFinite(renewalIntervalMs) || renewalIntervalMs <= 0) {
    throw new RangeError("renewalIntervalMs must be a positive number");
  }
  if (renewalIntervalMs >= leaseTtlMs) {
    throw new RangeError("renewalIntervalMs must be shorter than leaseTtlMs");
  }

  const now = options.now ?? Date.now;
  const ownerToken = (options.ownerToken ?? randomUUID)();
  const requestHash = hashValidatedRequest(options.validatedRequest);
  let claim: StoredIdempotencyRecord | null;
  try {
    claim = await options.store.claim(
      options.key,
      {
        state: "processing",
        requestHash,
        ownerToken,
        createdAtMs: now(),
        updatedAtMs: now(),
      },
      leaseTtlMs
    );
  } catch {
    // SET NX may have succeeded even when its response was lost. Do not run
    // until a later request can observe and resolve the stored state.
    return { kind: "unavailable" };
  }

  if (!claim) {
    let existing: StoredIdempotencyRecord | null;
    try {
      existing = await options.store.get(options.key);
    } catch {
      return { kind: "unavailable" };
    }
    // The competing record can expire between SET NX and GET. One fresh
    // atomic claim attempt is safe; a failed or ambiguous attempt still fails
    // closed.
    if (!existing) {
      try {
        claim = await options.store.claim(
          options.key,
          {
            state: "processing",
            requestHash,
            ownerToken,
            createdAtMs: now(),
            updatedAtMs: now(),
          },
          leaseTtlMs
        );
      } catch {
        return { kind: "unavailable" };
      }
      if (!claim) return { kind: "unavailable" };
    } else {
      return existingResult(existing.record, requestHash);
    }
  }

  const controller = new AbortController();
  let leaseLost = false;
  let renewalInFlight: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    if (leaseLost) return;
    renewalInFlight = renewalInFlight.then(async () => {
      if (leaseLost || !claim) return;
      try {
        const renewed = await options.store.renew(
          options.key,
          ownerToken,
          claim.revision,
          now(),
          leaseTtlMs
        );
        if (!renewed) {
          leaseLost = true;
          controller.abort();
          return;
        }
        claim = renewed;
      } catch {
        // The renewal may have applied even though its reply was lost. Stop
        // reporting success; the existing TTL remains the recovery bound.
        leaseLost = true;
        controller.abort();
      }
    });
  }, renewalIntervalMs);
  timer.unref?.();

  let response: IdempotencyResponse;
  try {
    response = await options.execute(controller.signal);
  } catch (err) {
    clearInterval(timer);
    await renewalInFlight;
    throw err;
  }
  clearInterval(timer);
  await renewalInFlight;
  if (leaseLost || !claim) return { kind: "unavailable" };

  const completed: CompletedIdempotencyRecord = {
    state: "completed",
    requestHash,
    ownerToken,
    response,
    completedAtMs: now(),
  };
  try {
    const finalized = await options.store.finalize(
      options.key,
      ownerToken,
      claim.revision,
      completed,
      resultTtlMs
    );
    if (finalized) return { kind: "executed", response };
  } catch {
    // Finalize may have committed before the REST response was lost. Read
    // back the state before deciding whether success can be returned.
  }
  return resolveAfterFinalize(options.store, options.key, requestHash, ownerToken);
}

/** Persist the signed transaction identity before allowing its first send.
 * `ready` is returned only after the processing claim has been atomically
 * replaced by a non-expiring outcome_unknown record. */
export async function beginIdempotentSubmission(options: {
  store: IdempotencyStore;
  key: string;
  validatedRequest: unknown;
  submission: SubmissionIdentity;
  leaseTtlMs?: number;
  now?: () => number;
  ownerToken?: () => string;
}): Promise<SubmissionClaimResult> {
  const now = options.now ?? Date.now;
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_IDEMPOTENCY_LEASE_TTL_MS;
  assertPositiveTtl(leaseTtlMs, "leaseTtlMs");
  validateSubmissionIdentity(options.submission);
  const requestHash = hashValidatedRequest(options.validatedRequest);
  const ownerToken = (options.ownerToken ?? randomUUID)();
  let claim: StoredIdempotencyRecord | null;
  try {
    claim = await options.store.claim(options.key, {
      state: "processing", requestHash, ownerToken,
      createdAtMs: now(), updatedAtMs: now(),
    }, leaseTtlMs);
  } catch {
    return { kind: "unavailable" };
  }
  if (!claim) {
    try {
      const existing = await options.store.get(options.key);
      if (!existing) return { kind: "unavailable" };
      return submissionExistingResult(existing.record, requestHash);
    } catch {
      return { kind: "unavailable" };
    }
  }
  const unknown: UnknownSubmissionRecord = {
    state: "outcome_unknown", requestHash, ownerToken,
    transactionHash: options.submission.transactionHash.toLowerCase(),
    signedXdr: options.submission.signedXdr,
    network: options.submission.network,
    sourceAccount: options.submission.sourceAccount,
    sequence: options.submission.sequence,
    maxTime: options.submission.maxTime,
    maxLedger: options.submission.maxLedger,
    submissionStartLedger: options.submission.submissionStartLedger ?? null,
    createdAtMs: now(), updatedAtMs: now(),
  };
  try {
    const persisted = await options.store.markOutcomeUnknown(
      options.key, ownerToken, claim.revision, unknown
    );
    if (persisted) return { kind: "ready", record: persisted.record as UnknownSubmissionRecord };
  } catch {
    // A lost reply is resolved by reading the durable record below.
  }
  try {
    const current = await options.store.get(options.key);
    if (current?.record.state === "outcome_unknown" &&
      current.record.ownerToken === ownerToken &&
      current.record.requestHash === requestHash &&
      current.record.transactionHash === unknown.transactionHash &&
      current.record.signedXdr === unknown.signedXdr) {
      return { kind: "ready", record: current.record };
    }
  } catch { /* fail closed */ }
  return { kind: "unavailable" };
}

function validateSubmissionIdentity(value: SubmissionIdentity): void {
  if ((value.network !== "mainnet" && value.network !== "testnet" &&
      value.network !== "futurenet") || !value.signedXdr || !value.sourceAccount ||
    !/^\d+$/.test(value.sequence) || !/^[\da-f]{64}$/i.test(value.transactionHash)) {
    throw new TypeError("Invalid signed transaction identity");
  }
  const validTime = value.maxTime === null || /^\d+$/.test(value.maxTime);
  const validLedger = value.maxLedger === null ||
    (Number.isSafeInteger(value.maxLedger) && value.maxLedger > 0);
  const hasFiniteTime =
    validTime && value.maxTime !== null && BigInt(value.maxTime) > 0n;
  if (!validTime || !validLedger || (!hasFiniteTime && value.maxLedger === null)) {
    throw new TypeError("Submission requires a finite upper validity bound");
  }
  if (value.submissionStartLedger !== undefined &&
    (!Number.isSafeInteger(value.submissionStartLedger) || value.submissionStartLedger < 0)) {
    throw new TypeError("Invalid submission start ledger");
  }
}

function submissionExistingResult(
  record: IdempotencyRecord,
  requestHash: string
): SubmissionClaimResult {
  if (record.requestHash !== requestHash) return { kind: "conflict" };
  if (record.state === "completed") return { kind: "replayed", response: record.response };
  if (record.state === "outcome_unknown") return { kind: "outcome-unknown", record };
  return { kind: "in-progress" };
}

/** Reconcile only authoritative outcomes. A missing record is terminal only
 * after both validity bounds have closed and retained RPC history covers the
 * entire possible submission interval. */
export async function reconcileIdempotentSubmission(options: {
  store: IdempotencyStore;
  key: string;
  observation: SubmissionObservation;
  now?: () => number;
  resultTtlMs?: number;
}): Promise<SubmissionReconciliationResult> {
  let stored: StoredIdempotencyRecord | null;
  try { stored = await options.store.get(options.key); }
  catch { return { kind: "unavailable" }; }
  if (!stored) return { kind: "unavailable" };
  if (stored.record.state !== "outcome_unknown") {
    return stored.record.state === "completed" && stored.record.resolution
      ? {
          kind: "completed",
          resolution: stored.record.resolution,
          response: stored.record.response,
        }
      : { kind: "unavailable" };
  }
  const record = stored.record;
  const observation = options.observation;
  if ((observation.kind === "SUCCESS" || observation.kind === "FAILED" ||
      observation.kind === "NOT_FOUND") &&
    observation.transactionHash !== record.transactionHash) {
    return { kind: "observation-mismatch" };
  }
  let resolution: CompletedIdempotencyRecord["resolution"];
  let response: IdempotencyResponse;
  if (observation.kind === "SUCCESS" || observation.kind === "FAILED") {
    resolution = observation.kind; response = observation.response;
  } else if (observation.kind === "NOT_FOUND") {
    if (!/^\d+$/.test(observation.latestLedgerCloseTime) ||
      !Number.isSafeInteger(observation.latestLedger) ||
      !Number.isSafeInteger(observation.oldestLedger) ||
      observation.oldestLedger < 0) {
      return { kind: "outcome-unknown", record };
    }
    const timeBoundStillOpen = record.maxTime !== null &&
      BigInt(String(observation.latestLedgerCloseTime)) <= BigInt(record.maxTime);
    const ledgerBoundStillOpen = record.maxLedger !== null &&
      observation.latestLedger < record.maxLedger;
    const historyCovers = record.submissionStartLedger !== null &&
      observation.oldestLedger <= record.submissionStartLedger &&
      observation.latestLedger >= record.submissionStartLedger;
    if (timeBoundStillOpen || ledgerBoundStillOpen || !historyCovers) {
      return { kind: "outcome-unknown", record };
    }
    resolution = "EXPIRED"; response = observation.expiredResponse;
  } else {
    return { kind: "outcome-unknown", record };
  }
  const completed: CompletedIdempotencyRecord = {
    state: "completed", requestHash: record.requestHash,
    ownerToken: record.ownerToken, resolution, response,
    completedAtMs: (options.now ?? Date.now)(),
  };
  try {
    const result = await options.store.resolveOutcomeUnknown(
      options.key, record.ownerToken, stored.revision, completed,
      options.resultTtlMs ?? DEFAULT_IDEMPOTENCY_RESULT_TTL_MS
    );
    if (result) return { kind: "completed", resolution: resolution!, response };
  } catch { /* check whether the CAS applied despite a lost reply */ }
  try {
    const current = await options.store.get(options.key);
    if (current?.record.state === "completed" &&
      current.record.ownerToken === record.ownerToken &&
      current.record.requestHash === record.requestHash &&
      current.record.resolution === resolution) {
      return { kind: "completed", resolution: resolution!, response: current.record.response };
    }
    if (current?.record.state === "outcome_unknown") {
      return { kind: "outcome-unknown", record: current.record };
    }
  } catch { /* fail closed */ }
  return { kind: "unavailable" };
}

async function resolveAfterFinalize(
  store: IdempotencyStore,
  key: string,
  requestHash: string,
  ownerToken: string
): Promise<IdempotencyResult> {
  try {
    const current = await store.get(key);
    if (!current) return { kind: "unavailable" };
    if (current.record.state === "completed") {
      if (
        current.record.requestHash === requestHash &&
        current.record.ownerToken === ownerToken
      ) {
        return { kind: "executed", response: current.record.response };
      }
      return existingResult(current.record, requestHash);
    }
    return existingResult(current.record, requestHash);
  } catch {
    return { kind: "unavailable" };
  }
}

function existingResult(
  record: IdempotencyRecord,
  requestHash: string
): IdempotencyResult {
  if (record.requestHash !== requestHash) return { kind: "conflict" };
  return record.state === "completed"
    ? { kind: "replayed", response: record.response }
    : { kind: "in-progress" };
}

function assertPositiveTtl(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number`);
  }
}

/** In-process implementation for deterministic tests and local use only. */
export function createInMemoryIdempotencyStore(options: {
  now?: () => number;
} = {}): IdempotencyStore {
  const now = options.now ?? Date.now;
  const entries = new Map<string, { value: string; expiresAt: number | null }>();

  function read(key: string): StoredIdempotencyRecord | null {
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && now() >= entry.expiresAt) {
      entries.delete(key);
      return null;
    }
    return {
      record: JSON.parse(entry.value) as IdempotencyRecord,
      revision: entry.value,
    };
  }

  return {
    async get(key) {
      return read(key);
    },
    async claim(key, record, leaseTtlMs) {
      if (read(key)) return null;
      const value = JSON.stringify(record);
      entries.set(key, { value, expiresAt: now() + leaseTtlMs });
      return { record, revision: value };
    },
    async renew(key, ownerToken, expectedRevision, updatedAtMs, leaseTtlMs) {
      const current = read(key);
      if (
        !current ||
        current.revision !== expectedRevision ||
        current.record.state !== "processing" ||
        current.record.ownerToken !== ownerToken
      ) {
        return null;
      }
      const renewed: ProcessingIdempotencyRecord = {
        ...current.record,
        updatedAtMs,
      };
      const value = JSON.stringify(renewed);
      entries.set(key, { value, expiresAt: now() + leaseTtlMs });
      return { record: renewed, revision: value };
    },
    async finalize(key, ownerToken, expectedRevision, record, resultTtlMs) {
      const current = read(key);
      if (
        !current ||
        current.revision !== expectedRevision ||
        current.record.state !== "processing" ||
        current.record.ownerToken !== ownerToken ||
        record.ownerToken !== ownerToken ||
        current.record.requestHash !== record.requestHash
      ) {
        return null;
      }
      const value = JSON.stringify(record);
      entries.set(key, { value, expiresAt: now() + resultTtlMs });
      return { record, revision: value };
    },
    async markOutcomeUnknown(key, ownerToken, expectedRevision, record) {
      const current = read(key);
      if (!current || current.revision !== expectedRevision ||
        current.record.state !== "processing" ||
        current.record.ownerToken !== ownerToken ||
        current.record.requestHash !== record.requestHash ||
        record.ownerToken !== ownerToken) return null;
      const value = JSON.stringify(record);
      entries.set(key, { value, expiresAt: null });
      return { record, revision: value };
    },
    async resolveOutcomeUnknown(key, ownerToken, expectedRevision, record, resultTtlMs) {
      const current = read(key);
      if (!current || current.revision !== expectedRevision ||
        current.record.state !== "outcome_unknown" ||
        current.record.ownerToken !== ownerToken || record.ownerToken !== ownerToken ||
        current.record.requestHash !== record.requestHash) return null;
      const value = JSON.stringify(record);
      entries.set(key, { value, expiresAt: now() + resultTtlMs });
      return { record, revision: value };
    },
  };
}
