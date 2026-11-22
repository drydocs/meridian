import { describe, it, expect } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import {
  FIXTURE_CALLER,
  FIXTURE_OTHER_WALLET,
  FIXTURE_CONTRACT,
  FIXTURE_ADAPTER_CONTRACT,
  FIXTURE_TESTNET,
  FIXTURE_MAINNET,
  makeTx,
  makeSimSuccess,
  makeSimError,
  makeScVal,
  makeKeypair,
} from "./fixtures.js";

// ---------------------------------------------------------------------------
// Address constants
// ---------------------------------------------------------------------------

describe("fixture address constants", () => {
  it("FIXTURE_CALLER is a valid G-address", () => {
    expect(FIXTURE_CALLER).toMatch(/^G[A-Z2-7]{55}$/);
  });

  it("FIXTURE_OTHER_WALLET is a valid G-address different from FIXTURE_CALLER", () => {
    expect(FIXTURE_OTHER_WALLET).toMatch(/^G[A-Z2-7]{55}$/);
    expect(FIXTURE_OTHER_WALLET).not.toBe(FIXTURE_CALLER);
  });

  it("FIXTURE_CONTRACT is a valid C-address", () => {
    expect(FIXTURE_CONTRACT).toMatch(/^C[A-Z2-7]{55}$/);
  });

  it("FIXTURE_ADAPTER_CONTRACT is a valid C-address different from FIXTURE_CONTRACT", () => {
    expect(FIXTURE_ADAPTER_CONTRACT).toMatch(/^C[A-Z2-7]{55}$/);
    expect(FIXTURE_ADAPTER_CONTRACT).not.toBe(FIXTURE_CONTRACT);
  });
});

// ---------------------------------------------------------------------------
// Network configs
// ---------------------------------------------------------------------------

describe("fixture network configs", () => {
  it("FIXTURE_TESTNET has the correct passphrase", () => {
    expect(FIXTURE_TESTNET.passphrase).toBe(
      "Test SDF Network ; September 2015"
    );
    expect(FIXTURE_TESTNET.network).toBe("testnet");
  });

  it("FIXTURE_MAINNET has the correct passphrase", () => {
    expect(FIXTURE_MAINNET.passphrase).toBe(
      "Public Global Stellar Network ; September 2015"
    );
    expect(FIXTURE_MAINNET.network).toBe("mainnet");
  });
});

// ---------------------------------------------------------------------------
// makeTx
// ---------------------------------------------------------------------------

describe("makeTx", () => {
  it("returns an unsigned stub by default", () => {
    const tx = makeTx();
    expect(tx.xdr).toBe("UNSIGNED_XDR_STUB");
    expect(tx.fee).toBe("150");
  });

  it("returns a signed stub when signed: true", () => {
    const tx = makeTx({ signed: true });
    expect(tx.xdr).toBe("SIGNED_XDR_STUB");
  });

  it("accepts a custom fee", () => {
    const tx = makeTx({ fee: "999" });
    expect(tx.fee).toBe("999");
  });

  it("is deterministic: same options produce identical output", () => {
    expect(makeTx({ fee: "300" })).toEqual(makeTx({ fee: "300" }));
  });

  it("signed and unsigned stubs are distinct", () => {
    expect(makeTx({ signed: false }).xdr).not.toBe(
      makeTx({ signed: true }).xdr
    );
  });
});

// ---------------------------------------------------------------------------
// makeSimSuccess
// ---------------------------------------------------------------------------

describe("makeSimSuccess", () => {
  it("returns a success shape with default resource fee", () => {
    const sim = makeSimSuccess();
    expect(sim.minResourceFee).toBe("500");
    expect(sim._parsed).toBe(true);
    expect(sim.result.retval).toBeDefined();
    expect(sim.events).toEqual([]);
  });

  it("accepts a custom resource fee", () => {
    const sim = makeSimSuccess({ resourceFee: "1200" });
    expect(sim.minResourceFee).toBe("1200");
  });

  it("accepts a custom retval", () => {
    const retval = xdr.ScVal.scvBool(true);
    const sim = makeSimSuccess({ retval });
    expect(sim.result.retval.switch()).toBe(xdr.ScValType.scvBool());
  });

  it("is deterministic: same options produce structurally equal output", () => {
    const a = makeSimSuccess({ resourceFee: "700" });
    const b = makeSimSuccess({ resourceFee: "700" });
    expect(a.minResourceFee).toBe(b.minResourceFee);
    expect(a._parsed).toBe(b._parsed);
  });
});

// ---------------------------------------------------------------------------
// makeSimError
// ---------------------------------------------------------------------------

describe("makeSimError", () => {
  it("generates a HostError string for the given code", () => {
    const sim = makeSimError(18);
    expect(sim.error).toContain("HostError: Error(Contract, #18)");
    expect(sim._parsed).toBe(true);
    expect(sim.events).toEqual([]);
  });

  it("includes a diagnostic event log in the generated error", () => {
    const sim = makeSimError(4);
    expect(sim.error).toContain("Event log");
    expect(sim.error).toContain("Diagnostic Event");
  });

  it("accepts a custom error string override", () => {
    const custom = "HostError: Error(WasmVm, InvalidAction)";
    const sim = makeSimError(0, { error: custom });
    expect(sim.error).toBe(custom);
  });

  it("is deterministic: same code produces the same error string", () => {
    expect(makeSimError(15).error).toBe(makeSimError(15).error);
  });

  it("produces distinct error strings for different codes", () => {
    expect(makeSimError(1).error).not.toBe(makeSimError(2).error);
  });
});

// ---------------------------------------------------------------------------
// makeScVal
// ---------------------------------------------------------------------------

describe("makeScVal", () => {
  it("i128 produces an i128 ScVal", () => {
    const v = makeScVal.i128(42n);
    expect(v.switch()).toBe(xdr.ScValType.scvI128());
  });

  it("u128 produces a u128 ScVal", () => {
    const v = makeScVal.u128(100n);
    expect(v.switch()).toBe(xdr.ScValType.scvU128());
  });

  it("u32 produces a u32 ScVal", () => {
    const v = makeScVal.u32(7);
    expect(v.switch()).toBe(xdr.ScValType.scvU32());
  });

  it("u64 produces a u64 ScVal", () => {
    const v = makeScVal.u64(1000n);
    expect(v.switch()).toBe(xdr.ScValType.scvU64());
  });

  it("bool produces a bool ScVal", () => {
    expect(makeScVal.bool(true).switch()).toBe(xdr.ScValType.scvBool());
    expect(makeScVal.bool(false).switch()).toBe(xdr.ScValType.scvBool());
  });

  it("address produces an Address ScVal", () => {
    const v = makeScVal.address(FIXTURE_CALLER);
    expect(v.switch()).toBe(xdr.ScValType.scvAddress());
  });

  it("symbol produces a Symbol ScVal", () => {
    const v = makeScVal.symbol("deposit");
    expect(v.switch()).toBe(xdr.ScValType.scvSymbol());
  });

  it("void produces a Void ScVal", () => {
    const v = makeScVal.void();
    expect(v.switch()).toBe(xdr.ScValType.scvVoid());
  });

  it("i128 is deterministic", () => {
    expect(makeScVal.i128(999n).toXDR()).toEqual(makeScVal.i128(999n).toXDR());
  });
});

// ---------------------------------------------------------------------------
// makeKeypair
// ---------------------------------------------------------------------------

describe("makeKeypair", () => {
  it("returns a valid Keypair with a public key", () => {
    const kp = makeKeypair();
    expect(kp.publicKey()).toMatch(/^G[A-Z2-7]{55}$/);
  });

  it("is deterministic: returns the same key on every call", () => {
    expect(makeKeypair().publicKey()).toBe(makeKeypair().publicKey());
  });

  it("can sign a message", () => {
    const kp = makeKeypair();
    const msg = Buffer.from("test-message");
    const sig = kp.sign(msg);
    expect(sig).toHaveLength(64);
  });
});
