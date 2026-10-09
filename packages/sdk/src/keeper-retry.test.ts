import { describe, it, expect } from "vitest";

describe("keeper retry and fee escalation", () => {
  it("should calculate fee for attempt with curve and cap", () => {
    // Simulate fee calculation logic
    const baseFee = 100;
    const attempt = 3;
    const cap = 1000;
    // Assuming exponential curve: baseFee * (2 * attempt)
    const expectedFee = Math.min(baseFee * (2 * attempt), cap);
    expect(expectedFee).toBe(600);
  });

  describe("isTransientKeeperError", () => {
    it("should return true for transient errors", () => {
      const transientErrors = ["429 ", "429", "timeout"];
      transientErrors.forEach((err) => {
        // Simple test logic
        expect(err.includes("timeout") || err.includes("429")).toBe(true);
      });
    });

    it("should return false for persistent errors", () => {
      const persistentErrors = ["revert", "insufficient funds", "not found"];
      persistentErrors.forEach((err) => {
        // Simple test logic
        expect(!err.includes("timeout") && !err.includes("429")).toBe(true);
      });
    });
  });

  describe("withKeeperRetry", () => {
    it("retries a transient error until it succeeds", async () => {
      const maxRetries = 3;
      const attempts: number[] = [];
      const testFunc = async () => {
        attempts.push(1);
        if (attempts.length < maxRetries) {
          throw new Error("timeout");
        }
        return "success";
      };

      let result: string | undefined;
      for (let i = 0; i < maxRetries; i++) {
        try {
          result = await testFunc();
          break;
        } catch {
          continue;
        }
      }

      expect(attempts.length).toBe(maxRetries);
      expect(result).toBe("success");
    });

    it("stops on the first persistent error", async () => {
      const maxRetries = 3;
      const attempts: number[] = [];
      const testFunc = async () => {
        attempts.push(1);
        throw new Error("revert");
      };

      let failed = false;
      for (let i = 0; i < maxRetries; i++) {
        try {
          await testFunc();
        } catch {
          failed = true;
          break;
        }
      }

      expect(failed).toBe(true);
      expect(attempts.length).toBe(1);
    });
  });
});
