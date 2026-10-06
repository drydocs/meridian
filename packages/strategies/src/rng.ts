const MASK_64 = (1n << 64n) - 1n;
const TWO_53 = 9_007_199_254_740_992;
const SEED_MIX_GAMMA = 0x9e3779b97f4a7c15n;

/**
 * xorshift64 over `bigint`, masked to 64 bits so the state cannot grow past a
 * machine word. Every draw is an exact integer, which is what keeps generated
 * paths identical across runs, machines and JavaScript engines.
 */
export class XorShift64 {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & MASK_64;
    this.#state = masked === 0n ? 1n : masked;
  }

  next(): bigint {
    let x = this.#state;
    x ^= (x << 13n) & MASK_64;
    x ^= x >> 7n;
    x ^= (x << 17n) & MASK_64;
    this.#state = x & MASK_64;
    return this.#state;
  }

  /** Uniform in [0, 1). Built from the top 53 bits so the division is exact. */
  nextFloat(): number {
    return Number(this.next() >> 11n) / TWO_53;
  }
}

/**
 * SplitMix64 over `seed + index * gamma`. Adding an index to the seed alone
 * would leave neighbouring paths correlated, so the sum is mixed.
 */
export function derivePathSeed(seed: bigint, pathIndex: number): bigint {
  if (!Number.isInteger(pathIndex) || pathIndex < 0) {
    throw new RangeError(
      `Path index must be a non-negative integer, received: ${pathIndex}`
    );
  }

  let z = (seed + BigInt(pathIndex) * SEED_MIX_GAMMA) & MASK_64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK_64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK_64;
  return (z ^ (z >> 31n)) & MASK_64;
}
