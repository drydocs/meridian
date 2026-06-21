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

