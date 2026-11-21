import { describe, expect, it } from "vitest";
import {
  ContractSimulationError,
  SorobanTimeoutError,
} from "@meridian/stellar-sdk-helpers";
import {
  ErrorCode,
  MeridianError,
  NetworkError,
  SimulationError,
  SlippageError,
  TimeoutError,
  UnsupportedError,
  ValidationError,
  classifyError,
  isMeridianError,
} from "./errors.js";

describe("error classes", () => {
  it("carry code, retryable and name", () => {
    const v = new ValidationError("bad");
    expect(v).toBeInstanceOf(Error);
    expect(v).toBeInstanceOf(MeridianError);
    expect(v.code).toBe(ErrorCode.VALIDATION);
    expect(v.retryable).toBe(false);
    expect(v.name).toBe("ValidationError");
    expect(new NetworkError("x").retryable).toBe(true);
    expect(new TimeoutError("x").retryable).toBe(true);
    expect(new UnsupportedError("x").retryable).toBe(false);
  });

  it("lets callers override retryable and keeps cause non-enumerable", () => {
    const cause = new Error("root");
    const e = new NetworkError("x", { cause, retryable: false });
    expect(e.retryable).toBe(false);
    expect(e.cause).toBe(cause);
    expect(Object.keys(e)).not.toContain("cause");
  });

  it("SlippageError is a SimulationError with its own code", () => {
    const e = new SlippageError("s", { contractCode: 18 });
    expect(e).toBeInstanceOf(SimulationError);
    expect(e.code).toBe(ErrorCode.SLIPPAGE);
    expect(e.contractCode).toBe(18);
  });

  it("isMeridianError narrows", () => {
    expect(isMeridianError(new ValidationError("x"))).toBe(true);
    expect(isMeridianError(new Error("x"))).toBe(false);
  });
});

describe("classifyError", () => {
  it("returns MeridianErrors unchanged", () => {
    const e = new ValidationError("x");
    expect(classifyError(e)).toBe(e);
  });

  it.each([15, 18])("maps contract code %i to SlippageError", (code) => {
    const src = new ContractSimulationError(code, `Error(Contract, #${code})`);
    const out = classifyError(src);
    expect(out).toBeInstanceOf(SlippageError);
    expect(out.message).toBe(src.message);
    expect(out.cause).toBe(src);
    expect((out as SimulationError).contractCode).toBe(code);
    expect(out.retryable).toBe(false);
  });

  it("does not classify MigrationLiabilityDrift (21) as SlippageError", () => {
    const out = classifyError(
      new ContractSimulationError(21, "Error(Contract, #21)")
    );
    expect(out).toBeInstanceOf(SimulationError);
    expect(out).not.toBeInstanceOf(SlippageError);
    expect((out as SimulationError).contractCode).toBe(21);
  });

  it("maps other contract codes to SimulationError", () => {
    const out = classifyError(
      new ContractSimulationError(20, "Error(Contract, #20)")
    );
    expect(out).toBeInstanceOf(SimulationError);
    expect(out).not.toBeInstanceOf(SlippageError);
    expect(out.code).toBe(ErrorCode.SIMULATION);
  });

  it("maps host simulation failures to SimulationError", () => {
    const out = classifyError(new Error("Simulation failed: boom"));
    expect(out.code).toBe(ErrorCode.SIMULATION);
    expect(out.retryable).toBe(false);
  });

  it("maps SorobanTimeoutError and timeout-ish errors to TimeoutError", () => {
    expect(classifyError(new SorobanTimeoutError(100))).toBeInstanceOf(
      TimeoutError
    );
    expect(classifyError(new Error("request timed out"))).toBeInstanceOf(
      TimeoutError
    );
    expect(
      classifyError(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))
    ).toBeInstanceOf(TimeoutError);
    expect(
      classifyError(
        Object.assign(new Error("x"), { response: { status: 504 } })
      )
    ).toBeInstanceOf(TimeoutError);
    expect(classifyError(new Error("x")).retryable).toBe(false);
  });

  it.each([
    ["ECONNRESET code", Object.assign(new Error("x"), { code: "ECONNRESET" })],
    ["429", Object.assign(new Error("x"), { response: { status: 429 } })],
    ["503", Object.assign(new Error("x"), { status: 503 })],
    ["fetch failed", new Error("fetch failed")],
    ["Network Error", new Error("Network Error")],
  ])("maps %s to a retryable NetworkError", (_n, err) => {
    const out = classifyError(err);
    expect(out).toBeInstanceOf(NetworkError);
    expect(out.retryable).toBe(true);
  });

  it("does not treat a 400 as network trouble", () => {
    const out = classifyError(
      Object.assign(new Error("bad request"), { response: { status: 400 } })
    );
    expect(out.code).toBe(ErrorCode.UNKNOWN);
  });

  it("wraps unknown values as UNKNOWN, non-retryable", () => {
    const out = classifyError("weird");
    expect(out.code).toBe(ErrorCode.UNKNOWN);
    expect(out.message).toBe("weird");
    expect(out.retryable).toBe(false);
  });
});
