export class XorShift64 {
  private state: bigint;

  constructor(seed: bigint) {
    this.state = seed !== undefined ? seed : 1n;
    if (this.state === 0n) this.state = 1n;
  }

  next(): bigint {
    let x = this.state;
    x ^= x >> 12n;
    x ^= x << 25n;
    x ^= x >> 27n;
    this.state = x;
    return x;
  }

  nextFloat(): number {
    // Returns a random number in [0, 1)
    // Use the top 52 bits of the 64-bit state for double precision
    const x = this.next();
    // 2^52 = 0x1000000000000
    // Use bigint division: shift right 12 bits effectively divides by 2^12
    // But we want to divide by 2^52, so we need to shift right 52-12=40 more bits
    // Actually, let's just use: (x / 2^52) as a number
    // But we can't divide bigint by bigint and get a number easily
    // Alternative: convert to number first, then divide
    const num = Number(x);
    // 2^52
    const Two52 = 0x1000000000000n;
    // Use the fact that Number can represent up to 2^53
    // Take the top 52 bits by dividing and flooring
    return num / Number(Two52);
  }
}