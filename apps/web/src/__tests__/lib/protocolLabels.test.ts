import { describe, it, expect } from "vitest";
import { PROTOCOL_LABEL } from "../../lib/protocolLabels";

describe("PROTOCOL_LABEL", () => {
  it.each([
    ["blend", "Blend Capital"],
    ["defindex", "DeFindex"],
    ["meridian", "Meridian"],
  ])("maps %s to %s", (key, label) => {
    expect(PROTOCOL_LABEL[key]).toBe(label);
  });

  it("contains exactly the known protocol keys", () => {
    expect(Object.keys(PROTOCOL_LABEL).sort()).toEqual([
      "blend",
      "defindex",
      "meridian",
    ]);
  });

  it("has no entry for an unknown protocol, so call sites fall back to the raw key", () => {
    expect(PROTOCOL_LABEL["unknown"]).toBeUndefined();
    // Mirrors the fallback used in VaultPanel and VaultStatePanel.
    expect(PROTOCOL_LABEL["unknown"] ?? "unknown").toBe("unknown");
  });
});
