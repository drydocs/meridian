import {
  ContractSimulationError,
  SorobanTimeoutError,
} from "@meridian/stellar-sdk-helpers";

/**
 * Stable, machine-readable error codes. Match on `error.code` (or use
 * `instanceof` against the subclasses) instead of string-matching messages.
 */
export const ErrorCode = {
  /** A caller-supplied argument was rejected before any network call. */
  VALIDATION: "VALIDATION",
  /** The simulation was rejected (contract error or host failure). */
  SIMULATION: "SIMULATION",
  /** The contract's slippage guard rejected the call. */
  SLIPPAGE: "SLIPPAGE",
  /** Transport-level failure: DNS, connection reset, 429/5xx from the RPC. */
  NETWORK: "NETWORK",
  /** An RPC call or operation exceeded its time budget. */
  TIMEOUT: "TIMEOUT",
  /** The vault deployment or its on-chain state cannot serve the request. */
  UNSUPPORTED: "UNSUPPORTED",
  /** Anything the SDK could not classify. */
  UNKNOWN: "UNKNOWN",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface MeridianErrorOptions {
  /** The underlying error, kept for debugging. Never passed to hooks. */
  cause?: unknown;
  /** Overrides the subclass's default `retryable` flag. */
  retryable?: boolean;
  /** Safe-to-log structured context (no secrets). */
  details?: Record<string, unknown>;
}

/** Base class of every error the SDK throws on purpose. */
export class MeridianError extends Error {
  readonly code: ErrorCodeValue;
  /**
   * `true` when repeating the same call can reasonably succeed (transient
   * network trouble, timeouts). It says nothing about whether it is *safe* to
   * repeat a state-changing call; the SDK only builds unsigned transactions.
   */
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;
  /** The underlying error, when one was wrapped. */
  declare readonly cause?: unknown;

  constructor(
    code: ErrorCodeValue,
    message: string,
    options: MeridianErrorOptions & { defaultRetryable?: boolean } = {}
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.retryable = options.retryable ?? options.defaultRetryable ?? false;
    this.details = Object.freeze({ ...options.details });
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
  }
}

export class ValidationError extends MeridianError {
  constructor(message: string, options: MeridianErrorOptions = {}) {
    super(ErrorCode.VALIDATION, message, options);
  }
}

export class SimulationError extends MeridianError {
  /** The vault contract's numeric error code, when the failure carried one. */
  readonly contractCode: number | undefined;
  constructor(
    message: string,
    options: MeridianErrorOptions & { contractCode?: number } = {},
    code: ErrorCodeValue = ErrorCode.SIMULATION
  ) {
    super(code, message, options);
    this.contractCode = options.contractCode;
  }
}

export class SlippageError extends SimulationError {
  constructor(
    message: string,
    options: MeridianErrorOptions & { contractCode?: number } = {}
  ) {
    super(message, options, ErrorCode.SLIPPAGE);
  }
}

export class NetworkError extends MeridianError {
  constructor(message: string, options: MeridianErrorOptions = {}) {
    super(ErrorCode.NETWORK, message, { defaultRetryable: true, ...options });
  }
}

export class TimeoutError extends MeridianError {
  constructor(message: string, options: MeridianErrorOptions = {}) {
    super(ErrorCode.TIMEOUT, message, { defaultRetryable: true, ...options });
  }
}

export class UnsupportedError extends MeridianError {
  constructor(message: string, options: MeridianErrorOptions = {}) {
    super(ErrorCode.UNSUPPORTED, message, options);
  }
}

export function isMeridianError(err: unknown): err is MeridianError {
  return err instanceof MeridianError;
}

/** Vault contract codes that mean "slippage guard tripped". */
const SLIPPAGE_CONTRACT_CODES: ReadonlySet<number> = new Set([15, 18]);

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "ERR_NETWORK",
]);
const NETWORK_MESSAGE =
  /network error|fetch failed|socket hang up|connection (?:reset|refused|closed)|getaddrinfo|ENOTFOUND|ECONNRESET|ECONNREFUSED/i;
const TIMEOUT_MESSAGE = /timed? ?out|timeout/i;
const CONTRACT_CODE = /Error\(\s*Contract\s*,\s*#(\d+)\s*\)/i;

function httpStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as {
    status?: unknown;
    response?: { status?: unknown };
  };
  const status = e.response?.status ?? e.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Map any thrown value onto the SDK's taxonomy. An existing `MeridianError`
 * is returned unchanged; other errors keep their message and are attached as
 * `cause`.
 */
export function classifyError(err: unknown): MeridianError {
  if (err instanceof MeridianError) return err;

  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof ContractSimulationError) {
    const opts = { cause: err, contractCode: err.code };
    return SLIPPAGE_CONTRACT_CODES.has(err.code)
      ? new SlippageError(message, opts)
      : new SimulationError(message, opts);
  }
  if (err instanceof SorobanTimeoutError) {
    return new TimeoutError(message, { cause: err });
  }

  const status = httpStatus(err);
  const code =
    typeof err === "object" && err !== null
      ? (err as { code?: unknown }).code
      : undefined;

  if (typeof code === "string" && code === "ETIMEDOUT") {
    return new TimeoutError(message, { cause: err });
  }
  if (status === 408 || status === 504) {
    return new TimeoutError(message, { cause: err });
  }
  if (
    status === 429 ||
    (status !== undefined && status >= 500) ||
    (typeof code === "string" && NETWORK_CODES.has(code)) ||
    NETWORK_MESSAGE.test(message)
  ) {
    return new NetworkError(message, { cause: err });
  }
  if (err instanceof Error && TIMEOUT_MESSAGE.test(message)) {
    return new TimeoutError(message, { cause: err });
  }

  if (/^Simulation failed/i.test(message)) {
    const contract = Number(CONTRACT_CODE.exec(message)?.[1]);
    return new SimulationError(message, {
      cause: err,
      ...(Number.isFinite(contract) ? { contractCode: contract } : {}),
    });
  }

  return new MeridianError(ErrorCode.UNKNOWN, message, { cause: err });
}
