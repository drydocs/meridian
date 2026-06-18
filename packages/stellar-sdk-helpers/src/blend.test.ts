import { describe, it, expect } from "vitest";
import { blendAssetForVault } from "./blend";

describe("blendAssetForVault", () => {
  it("maps USDC vault ids to the usdc reserve", () => {
    expect(blendAssetForVault("blend-usdc-fixed")).toBe("usdc");
    expect(blendAssetForVault("blend-usdc-variable")).toBe("usdc");
  });

  it("maps EURC vault ids to the eurc reserve", () => {
    expect(blendAssetForVault("blend-eurc-fixed")).toBe("eurc");
    expect(blendAssetForVault("blend-eurc-variable")).toBe("eurc");
  });

  it("throws for a vault id with no mapped reserve asset", () => {
    expect(() => blendAssetForVault("blend-xlm-fixed")).toThrow(/no blend reserve asset/i);
  });
});
