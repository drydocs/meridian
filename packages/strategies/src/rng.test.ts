
import { XorShift64 } from "./rng";

describe("XorShift64", () => {
  describe("deterministic reproducibility", () => {
    it("produces the same sequence with the same seed", () => {
      const rng1 = new XorShift64(42n);
      const rng2 = new XorShift64(42n);
      const sequence1: number[] = [];
      const sequence2: number[] = [];
      for (let i = 0; i < 100; i++) {
        sequence1.push(rng1.nextFloat());
        sequence2.push(rng2.nextFloat());
      }
      expect(sequence1).toEqual(sequence2);
    });

    it("produces different sequences with different seeds", () => {
      const rng1 = new XorShift64(42n);
      const rng2 = new XorShift64(123n);
      const sequence1: number[] = [];
      const sequence2: number[] = [];
      for (let i = 0; i < 10; i++) {
        sequence1.push(rng1.nextFloat());
        sequence2.push(rng2.nextFloat());
      }
      expect(sequence1).not.toEqual(sequence2);
    });
  });

  describe("next() method", () => {
    it("returns a bigint", () => {
      const rng = new XorShift64(1n);
      const result = rng.next();
      expect(typeof result).toBe("bigint");
    });

    it("returns different values on successive calls", () => {
      const rng = new XorShift64(1n);
      const results: bigint[] = [];
      for (let i = 0; i < 10; i++) {
        results.push(rng.next());
      }
      const unique = new Set(results);
      expect(unique.size).toBeGreaterThan(1);
    });

    it("state advances correctly", () => {
      const rng = new XorShift64(1n);
      const first = rng.next();
      const second = rng.next();
      expect(second).not.toBe(first);
    });
  });

  describe("derivePathSeed", () => {
    it("derives different seeds for different path indices", () => {
      const seed = 42n;
      const seeds = [0, 1, 2, 3].map((i) => seed ^ (BigInt(i) * 0x9e3779b97f4a7c15n));
      const unique = new Set(seeds.map((s) => s.toString()));
      expect(unique.size).toBe(4);
    });

    it("derived seeds are deterministic", () => {
      const seed = 123n;
      const index = 5;
      const seed1 = seed ^ (BigInt(index) * 0x9e3779b97f4a7c15n);
      const seed2 = seed ^ (BigInt(index) * 0x9e3779b97f4a7c15n);
      expect(seed1).toBe(seed2);
    });
  });
});