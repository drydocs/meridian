/**
 * Client-side error mapping layer.
 *
 * API errors arrive as plain `Error` objects whose `.message` is the string
 * the server sent. This module translates those known strings to i18n keys so
 * the UI shows localized, actionable messages instead of raw server text.
 *
 * Unknown errors get a generic message plus a short reference code that
 * support can correlate with the original error logged to the console.
 */

import type { TFunction } from "i18next";

/**
 * Map from the exact server-sent error strings defined in
 * `packages/api-core/src/tx.ts` to i18n translation keys.
 */
const SERVER_MESSAGE_TO_KEY: Record<string, string> = {
  // Contract code 3 — DepositsPaused
  "Deposits are currently paused. Try again later.": "errors.depositsPaused",

  // Contract code 7 — InsufficientShares
  "Insufficient shares for this withdrawal.": "errors.insufficientShares",

  // Contract code 15 — MinAmountOutNotMet (withdrawal slippage)
  "Withdrawal returned less USDC than your minimum. Adjust slippage and retry.":
    "errors.withdrawalSlippage",

  // Contract code 18 — SlippageExceeded (deposit slippage)
  "Slippage tolerance exceeded. Adjust slippage and retry.":
    "errors.slippageExceeded",

  // MissingTrustlineError — single asset
  "Missing USDC trustline. Add the trustline via POST /api/v1/tx/add-trustline before depositing or withdrawing.":
    "errors.missingUsdcTrustline",

  // MissingTrustlineError — multiple assets (USDC + mUSDC)
  "Missing MUSDC trustline. Add the trustline via POST /api/v1/tx/add-trustline before depositing or withdrawing.":
    "errors.missingTrustline",

  "Missing required trustlines: USDC, MUSDC. Add them via POST /api/v1/tx/add-trustline before depositing or withdrawing.":
    "errors.missingTrustline",

  // CALLER_FACING_TX_ERRORS passthrough
  "USDC trustline missing": "errors.missingUsdcTrustline",
  "All required trustlines already exist": "errors.trustlinesAlreadyExist",

  // Per-action 500 fallbacks from the API
  "Failed to build deposit transaction": "errors.depositBuildFailed",
  "Failed to build withdraw transaction": "errors.withdrawBuildFailed",
  "Failed to build trustline transaction": "errors.trustlineBuildFailed",
  "Failed to submit transaction": "errors.submitFailed",

  // wallet.sign() — wallet disconnected
  "Wallet Disconnected": "errors.walletDisconnected",
};

/**
 * Check whether a server error message starts with a MissingTrustlineError
 * prefix (the asset list varies, so an exact match is not always possible).
 */
function isMissingTrustlineMessage(message: string): boolean {
  return (
    message.startsWith("Missing ") &&
    message.includes("trustline") &&
    message.includes("add-trustline")
  );
}

/**
 * Derive a short, opaque reference code from a raw error message. The code
 * is included in unknown-error toasts so users can quote it in support
 * requests without the UI ever showing internal detail.
 *
 * Uses a simple djb2-style hash truncated to 6 hex characters — stable,
 * dependency-free, and fast enough to run synchronously on the main thread.
 */
function referenceCode(raw: string): string {
  let h = 5381;
  for (let i = 0; i < raw.length; i++) {
    h = ((h << 5) + h) ^ raw.charCodeAt(i);
    h = h >>> 0; // keep as uint32
  }
  return h.toString(16).padStart(6, "0").slice(0, 6).toUpperCase();
}

export interface MappedError {
  /** The user-facing message to show in the toast. */
  message: string;
  /**
   * Present only for unknown errors — the opaque code shown to the user.
   * The raw error has already been logged to console.error at this point.
   */
  referenceCode?: string;
}

/**
 * Map a caught error to a localized, user-facing message.
 *
 * @param err  — The value caught by a catch block.
 * @param t    — The i18next translation function.
 * @param fallbackKey — i18n key used when no specific mapping matches and the
 *                      error is not unknown (e.g. "vaultActions.depositFailed").
 *                      Pass `undefined` to skip the named fallback and go
 *                      straight to the generic unknown-error message.
 */
export function mapError(
  err: unknown,
  t: TFunction,
  fallbackKey?: string
): MappedError {
  if (!(err instanceof Error)) {
    return { message: fallbackKey ? t(fallbackKey) : t("errors.unknown") };
  }

  const raw = err.message;

  // 1. Exact match in the lookup table.
  if (raw in SERVER_MESSAGE_TO_KEY) {
    return { message: t(SERVER_MESSAGE_TO_KEY[raw]!) };
  }

  // 2. MissingTrustlineError — dynamic asset list in message.
  if (isMissingTrustlineMessage(raw)) {
    return { message: t("errors.missingTrustline") };
  }

  // 3. Named per-action fallback when the caller provides one.
  if (fallbackKey) {
    console.error("[Meridian] unmapped error (key=%s):", fallbackKey, err);
    return { message: t(fallbackKey) };
  }

  // 4. Fully unknown — show generic message + reference code, log the raw.
  const code = referenceCode(raw);
  console.error("[Meridian] unknown error (ref=%s):", code, err);
  return {
    message: t("errors.unknownWithRef", { ref: code }),
    referenceCode: code,
  };
}
