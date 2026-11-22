/**
 * Deterministic test fixtures for SDK and stellar-sdk-helpers tests.
 *
 * All builders are pure functions: they accept only plain values, make no
 * network calls, and return the same output for the same inputs every time.
 * They must not import from any module that pulls in a live RPC client.
 *
 * Usage
 * -----
 * ```ts
 * import { makeTx, makeSimSuccess, makeSimError, makeScVal } from "./testing/fixtures.js";
 *
 * const tx     = makeTx();                     // unsigned XDR stub
 * const signed = makeTx({ signed: true });     // signed XDR stub
 * const sim    = makeSimSuccess();             // successful Soroban simulation
 * const failed = makeSimError(18);             // simulation with ContractError #18
 * const val    = makeScVal.i128(42n);          // ScVal helpers
 * ```
 */

import {
  Address,
  Keypair,
  nativeToScVal,
  SorobanDataBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import type { Transaction } from "../types.js";

// ---------------------------------------------------------------------------
// Well-known deterministic addresses
// ---------------------------------------------------------------------------

/** A fixed G-address used as the default caller in fixtures. */
export const FIXTURE_CALLER =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/** A second G-address useful for receiver/owner mismatch tests. */
export const FIXTURE_OTHER_WALLET =
  "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57";

/** A fixed C-address used as the default contract in fixtures. */
export const FIXTURE_CONTRACT =
  "CAIQBVLBIUWQGE6DQUHDMZ2QWI7QP6KTCN7GP2BIZ6JZC4ES47JO4SSM";

/** A fixed C-address used as a secondary contract (e.g. adapter). */
export const FIXTURE_ADAPTER_CONTRACT =
  "CBNKERYAG7VZNBH2V3TF5JBXLD3MXLVQW5GG4AO445EUDCPKP4D2DDP2";

/** Testnet network config shared across fixture consumers. */
export const FIXTURE_TESTNET = {
  network: "testnet" as const,
  rpcUrl: "https://soroban-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
};

/** Mainnet network config. */
export const FIXTURE_MAINNET = {
  network: "mainnet" as const,
  rpcUrl: "https://soroban-mainnet.stellar.org",
  passphrase: "Public Global Stellar Network ; September 2015",
};

// ---------------------------------------------------------------------------
// Transaction builders
// ---------------------------------------------------------------------------

export interface MakeTxOptions {
  /** When true the XDR stub is labelled as already signed. Default: false. */
  signed?: boolean;
  /** Fee string in stroops. Default: "150". */
  fee?: string;
}

/**
 * Returns a deterministic `Transaction` stub.
 *
 * The `xdr` field is a placeholder string, not a real Stellar transaction.
 * Use it wherever a `Transaction` type is required but the XDR bytes are not
 * inspected by the test.
 */
export function makeTx(opts: MakeTxOptions = {}): Transaction {
  const { signed = false, fee = "150" } = opts;
  return {
    xdr: signed ? "SIGNED_XDR_STUB" : "UNSIGNED_XDR_STUB",
    fee,
  };
}

// ---------------------------------------------------------------------------
// Soroban simulation result builders
// ---------------------------------------------------------------------------

export interface MakeSimSuccessOptions {
  /** Resource fee in stroops appended to the base fee. Default: "500". */
  resourceFee?: string;
  /** The Soroban return value. Default: scvVoid. */
  retval?: xdr.ScVal;
}

/**
 * Returns a successful Soroban simulation result that matches the shape
 * `rpc.Server.simulateTransaction` resolves to.
 *
 * Compatible with `vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue(...)`.
 */
export function makeSimSuccess(opts: MakeSimSuccessOptions = {}) {
  const { resourceFee = "500", retval = xdr.ScVal.scvVoid() } = opts;
  return {
    id: "1",
    latestLedger: 1,
    minResourceFee: resourceFee,
    events: [],
    transactionData: new SorobanDataBuilder().setResourceFee(resourceFee),
    result: { auth: [], retval },
    _parsed: true as const,
  };
}

export interface MakeSimErrorOptions {
  /** The raw `sim.error` string. When omitted a `HostError` for `code` is generated. */
  error?: string;
}

/**
 * Returns a Soroban simulation error result.
 *
 * Pass a contract error `code` to generate a standard `HostError: Error(Contract, #N)`
 * string automatically, or override with a custom `error` string via options.
 *
 * Compatible with `vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue(...)`.
 */
export function makeSimError(code: number, opts: MakeSimErrorOptions = {}) {
  const error =
    opts.error ??
    `HostError: Error(Contract, #${code})\n\n` +
      "Event log (newest first):\n" +
      `   0: [Diagnostic Event] contract:CBQ..., topics:[error, Error(Contract, #${code})], ` +
      `data:"escalating error to VM trap from failed host function call: call"\n`;
  return {
    id: "1",
    latestLedger: 1,
    error,
    events: [],
    _parsed: true as const,
  };
}

// ---------------------------------------------------------------------------
// ScVal helpers
// ---------------------------------------------------------------------------

/**
 * Convenience builders for common `xdr.ScVal` types.
 *
 * These wrap `nativeToScVal` / direct XDR constructors and give tests a
 * named, self-documenting API instead of raw `nativeToScVal(42n, { type: "i128" })`.
 */
export const makeScVal = {
  /** An i128 ScVal. */
  i128: (value: bigint): xdr.ScVal => nativeToScVal(value, { type: "i128" }),

  /** A u128 ScVal. */
  u128: (value: bigint): xdr.ScVal => nativeToScVal(value, { type: "u128" }),

  /** A u32 ScVal. */
  u32: (value: number): xdr.ScVal => nativeToScVal(value, { type: "u32" }),

  /** A u64 ScVal. */
  u64: (value: bigint): xdr.ScVal => nativeToScVal(value, { type: "u64" }),

  /** A boolean ScVal. */
  bool: (value: boolean): xdr.ScVal => nativeToScVal(value, { type: "bool" }),

  /** An Address ScVal from a G- or C-address string. */
  address: (address: string): xdr.ScVal => nativeToScVal(new Address(address)),

  /** A Symbol ScVal. */
  symbol: (value: string): xdr.ScVal => xdr.ScVal.scvSymbol(value),

  /** A void ScVal. */
  void: (): xdr.ScVal => xdr.ScVal.scvVoid(),
} as const;

// ---------------------------------------------------------------------------
// Keypair helpers (deterministic from a fixed seed)
// ---------------------------------------------------------------------------

/**
 * A deterministic Keypair derived from a fixed 32-byte seed.
 * Safe for use in tests that need a real signing keypair without network access.
 *
 * The seed is `0x01` repeated 32 times; this is public knowledge and must
 * never be used for real accounts.
 */
export function makeKeypair(): Keypair {
  return Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x01));
}
