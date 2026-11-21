import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mapError, WALLET_DISCONNECTED_ERROR } from "../../lib/errorMapper";
import type { TFunction } from "i18next";

// Minimal t() that returns the key (and optionally the interpolation params
// for the unknownWithRef case), so tests are independent of translation file content.
const t = ((key: string, opts?: Record<string, unknown>) => {
  if (opts && Object.keys(opts).length) {
    return `${key}(${JSON.stringify(opts)})`;
  }
  return key;
}) as unknown as TFunction;

describe("mapError", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- non-Error values -------------------------------------------------------

  it("returns fallbackKey for a non-Error throw when fallbackKey is given", () => {
    const result = mapError("oops", t, "vaultActions.depositFailed");
    expect(result.message).toBe("vaultActions.depositFailed");
  });

  it("returns errors.unknown for a non-Error throw without a fallbackKey", () => {
    const result = mapError(42, t);
    expect(result.message).toBe("errors.unknown");
  });

  // ---- known server messages --------------------------------------------------

  const knownCases: Array<[string, string]> = [
    [
      "Deposits are currently paused. Try again later.",
      "errors.depositsPaused",
    ],
    ["Insufficient shares for this withdrawal.", "errors.insufficientShares"],
    [
      "Withdrawal returned less USDC than your minimum. Adjust slippage and retry.",
      "errors.withdrawalSlippage",
    ],
    [
      "Slippage tolerance exceeded. Adjust slippage and retry.",
      "errors.slippageExceeded",
    ],
    [
      "Missing USDC trustline. Add the trustline via POST /api/v1/tx/add-trustline before depositing or withdrawing.",
      "errors.missingUsdcTrustline",
    ],
    [
      "Missing MUSDC trustline. Add the trustline via POST /api/v1/tx/add-trustline before depositing or withdrawing.",
      "errors.missingTrustline",
    ],
    [
      "Missing required trustlines: USDC, MUSDC. Add them via POST /api/v1/tx/add-trustline before depositing or withdrawing.",
      "errors.missingTrustline",
    ],
    ["USDC trustline missing", "errors.missingUsdcTrustline"],
    ["All required trustlines already exist", "errors.trustlinesAlreadyExist"],
    ["Failed to build deposit transaction", "errors.depositBuildFailed"],
    ["Failed to build withdraw transaction", "errors.withdrawBuildFailed"],
    ["Failed to build trustline transaction", "errors.trustlineBuildFailed"],
    ["Failed to submit transaction", "errors.submitFailed"],
    [WALLET_DISCONNECTED_ERROR, "errors.walletDisconnected"],
    ["User declined access", "errors.walletDeclined"],
    ["User declined request", "errors.walletDeclined"],
    ["User cancelled", "errors.walletDeclined"],
    ["User rejected", "errors.walletDeclined"],
    ["Signing cancelled", "errors.walletDeclined"],
    ["Connection cancelled", "errors.walletDeclined"],
  ];

  knownCases.forEach(([serverMessage, expectedKey]) => {
    it(`maps known message "${serverMessage.slice(0, 50)}…" → ${expectedKey}`, () => {
      const result = mapError(new Error(serverMessage), t);
      expect(result.message).toBe(expectedKey);
      expect(result.referenceCode).toBeUndefined();
    });
  });

  it("does not log to console.error for a known mapped message", () => {
    mapError(new Error("Deposits are currently paused. Try again later."), t);
    expect(console.error).not.toHaveBeenCalled();
  });

  // ---- MissingTrustlineError dynamic variants ---------------------------------

  it("maps dynamic MissingTrustlineError message with extra assets", () => {
    const result = mapError(
      new Error(
        "Missing USDC, MUSDC trustlines. Add them via POST /api/v1/tx/add-trustline before depositing or withdrawing."
      ),
      t
    );
    expect(result.message).toBe("errors.missingTrustline");
  });

  // ---- wallet decline dynamic variants ----------------------------------------

  it("maps dynamic wallet decline messages via pattern match", () => {
    const declineMessages = [
      "User cancelled the request",
      "User rejected the request",
      "User declined to sign",
    ];
    for (const msg of declineMessages) {
      const result = mapError(new Error(msg), t);
      expect(result.message).toBe("errors.walletDeclined");
    }
  });

  it("does not treat on-chain or network failures as a wallet decline", () => {
    // The decline pattern is anchored to a leading decline verb, so a message
    // that merely contains one of those words further on — e.g. a contract or
    // network rejection — must not be misreported as "You declined the
    // request" (it falls through to the unmapped path instead).
    const notDecline = [
      "Transaction rejected",
      "Transaction declined by the network",
    ];
    for (const msg of notDecline) {
      const result = mapError(new Error(msg), t);
      expect(result.message).not.toBe("errors.walletDeclined");
    }
  });

  // ---- named fallback with ref code ------------------------------------------

  it("uses the named fallback with a reference code for unrecognised Error messages", () => {
    const result = mapError(
      new Error("Transaction ${hash} failed on-chain"),
      t,
      "vaultActions.depositFailed"
    );
    // fallbackWithRef interpolates the action label and ref code
    expect(result.message).toMatch(/errors\.fallbackWithRef/);
    expect(result.referenceCode).toMatch(/^[0-9A-F]{6}$/);
    expect(console.error).toHaveBeenCalledOnce();
  });

  it("logs the raw error when falling back to the named key", () => {
    const err = new Error("some internal message");
    mapError(err, t, "vaultActions.withdrawalFailed");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("unmapped error"),
      expect.stringMatching(/^[0-9A-F]{6}$/),
      err
    );
  });

  // ---- fully unknown ----------------------------------------------------------

  it("returns unknownWithRef with a reference code for an unrecognised Error without a fallback", () => {
    const result = mapError(new Error("HostError: some internal detail"), t);
    expect(result.message).toMatch(/errors\.unknownWithRef/);
    expect(result.referenceCode).toMatch(/^[0-9A-F]{6}$/);
  });

  it("produces the same reference code for the same message text", () => {
    const err = new Error("Simulation failed: HostError");
    const a = mapError(err, t);
    const b = mapError(err, t);
    expect(a.referenceCode).toBe(b.referenceCode);
  });

  it("produces different reference codes for different messages", () => {
    const a = mapError(new Error("error alpha"), t);
    const b = mapError(new Error("error beta"), t);
    expect(a.referenceCode).not.toBe(b.referenceCode);
  });

  it("logs the raw error for unknown errors", () => {
    const err = new Error("HostError: opaque");
    mapError(err, t);
    // console.error is called as:
    //   console.error("[Meridian] unmapped error (ref=%s):", code, err)
    // The second argument is the reference code string itself, not a
    // "ref=…" formatted string; the format specifier lives in arg 1.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("unmapped error"),
      expect.stringMatching(/^[0-9A-F]{6}$/),
      err
    );
  });

  it("does not expose the raw message in the returned message string", () => {
    const raw = "Simulation failed: HostError. Contract(123)";
    const result = mapError(new Error(raw), t);
    expect(result.message).not.toContain(raw);
    expect(result.message).not.toContain("HostError");
  });
});

// ---- locale key parity -------------------------------------------------------
// These tests verify the new keys exist in both translation files, mirroring
// the structure already enforced by apps/web/src/__tests__/i18n.test.ts.

import en from "../../../messages/en.json";
import fr from "../../../messages/fr.json";

describe("errors i18n keys", () => {
  const errorKeys = [
    "depositsPaused",
    "insufficientShares",
    "withdrawalSlippage",
    "slippageExceeded",
    "missingUsdcTrustline",
    "missingTrustline",
    "trustlinesAlreadyExist",
    "depositBuildFailed",
    "withdrawBuildFailed",
    "trustlineBuildFailed",
    "submitFailed",
    "walletDisconnected",
    "walletDeclined",
    "unknown",
    "unknownWithRef",
    "fallbackWithRef",
  ];

  type TranslationFile = { errors?: Record<string, string> };

  errorKeys.forEach((key) => {
    it(`en has errors.${key}`, () => {
      expect(typeof (en as unknown as TranslationFile).errors?.[key]).toBe(
        "string"
      );
    });

    it(`fr has errors.${key}`, () => {
      expect(typeof (fr as unknown as TranslationFile).errors?.[key]).toBe(
        "string"
      );
    });
  });
});
