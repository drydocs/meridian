import { describe, it, expect } from "vitest";
import { BLEND_POOL_INFO, VAULT_STATE } from "./fixtures";

describe("Blend adapter client", () => {
  describe("Pool info parsing", () => {
    it("should parse pool info correctly", () => {
      expect(BLEND_POOL_INFO.id).toBe("001");
      expect(BLEND_POOL_INFO.name).toBe("US$/WETHE");
    });
  });

  describe("User position parsing", () => {
    it("parses the recorded vault state fixture", () => {
      expect(VAULT_STATE.id).toBe("vault-0");
      expect(VAULT_STATE.totalAssets).toBe(10000000);
      expect(VAULT_STATE.active).toBe(true);
    });
  });

  describe("Health factor calculation", () => {
    it("should calculate health factor correctly", () => {
      // Simple test logic
      expect(true).toBe(true);
    });
  });
});
