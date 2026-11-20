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
 * Stable, locale-independent code thrown by the disconnected guard in
 * `useSignAndSubmit`. `mapError` matches on this code rather than the
 * translated `walletConnect.walletDisconnected` string, whose text differs
 * per locale and so could never match the table in non-English builds.
 */
export const WALLET_DISCONNECTED_ERROR = "WALLET_DISCONNECTED";

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

  // useSignAndSubmit's disconnected guard. Matched on a stable code, not the
  // translated `walletConnect.walletDisconnected` string (which differs per
  // locale and so would never match here in fr).
  [WALLET_DISCONNECTED_ERROR]: "errors.walletDisconnected",

  // wallet.connect() / wallet.sign() — user closed the popup or rejected the
  // request. These strings come from the wallet adapters / SDKs, which do not
  // localize, so matching the English text is stable across locales.
  "User declined access": "errors.walletDeclined",
  "User declined request": "errors.walletDeclined",
  "User cancelled": "errors.walletDeclined",
  "User rejected": "errors.walletDeclined",

  // Adapters throw this when sign() returns no signed XDR (the user closed the
  // signing popup). It does not start with a decline verb, so the anchored
  // dynamic fallback below would miss it; pin it here instead.
  "Signing cancelled": "errors.walletDeclined",

  // Albedo throws this when the user rejects the connect popup.
  "Connection cancelled": "errors.walletDeclined",
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
 * Check whether the error message represents a user-initiated wallet decline
 * (user closed the popup, rejected the request, etc.). These share a pattern
 * but can arrive with different exact phrasings from different wallet adapters.
 */
function isWalletDeclineMessage(message: string): boolean {
  // Treat a message as a wallet decline only when a decline verb leads it,
  // optionally prefixed with "user ". A bare substring test would also match
  // network/contract failures that merely contain one of these words later
  // in the message (e.g. "Transaction rejected"), wrongly surfacing them as
  // "You declined the request". Anchoring at the start avoids that; the known
  // adapter strings that don't fit this shape ("Signing cancelled",
  // "Connection cancelled") are pinned in the exact-match table above.
  return /^(user )?(declined|cancel(l)?ed|rejected)\b/i.test(message);
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

  // 3. Dynamic wallet decline pattern — catches adapter-specific phrasings
  //    not covered by the exact-match table above.
  if (isWalletDeclineMessage(raw)) {
    return { message: t("errors.walletDeclined") };
  }

  // 4. Unmapped error: always compute a reference code and log the raw error,
  //    regardless of whether the caller supplied a fallbackKey. The fallbackKey
  //    changes only the visible label (e.g. "Deposit failed (ref: A1B2C3)"),
  //    so callers still get a contextual message while every unmapped path
  //    remains traceable via the reference code.
  const code = referenceCode(raw);
  console.error("[Meridian] unmapped error (ref=%s):", code, err);

  if (fallbackKey) {
    return {
      message: t("errors.fallbackWithRef", {
        action: t(fallbackKey),
        ref: code,
      }),
      referenceCode: code,
    };
  }

  return {
    message: t("errors.unknownWithRef", { ref: code }),
    referenceCode: code,
  };
}
