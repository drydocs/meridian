// Matches patterns that reveal internal deployment details: RPC URLs and
// Stellar contract (C-address) identifiers embedded in SDK error messages.
const INTERNAL_DETAIL = /https?:\/\/|C[A-Z2-7]{50,}/;

/**
 * Extracts a safe, first-line summary from an unknown catch value.
 * Strips multi-line SDK diagnostics, RPC URLs, and contract addresses.
 * Returns `fallback` when no clean message can be derived.
 */
export function sanitizeTxError(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  const first = err.message.split("\n")[0].trim();
  if (!first || INTERNAL_DETAIL.test(first)) return fallback;
  return first;
}

export function shortenAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/** Returns true when `key` is a well-formed Stellar G-address (base32, 56 chars). */
export function isValidStellarAddress(key: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(key);
}

/**
 * Retries `fn` up to `maxAttempts` times with exponential backoff starting at
 * `baseDelayMs`. Throws the last error when all attempts are exhausted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 200
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
      }
    }
  }
  throw lastErr;
}

