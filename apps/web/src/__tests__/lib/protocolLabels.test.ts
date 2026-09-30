import { describe, it, expect } from "vitest";

import { PROTOCOL_LABEL } from "../../lib/protocolLabels";

describe("PROTOCOL_LABEL", () => {
  it("maps the blend key to its human label", () => {
    expect(PROTOCOL_LABEL.blend).toBe("Blend Capital");
  });

  it("maps the defindex key to its human label", () => {
    expect(PROTOCOL_LABEL.defindex).toBe("DeFindex");
  });

  it("maps the meridian key to its human label", () => {
    expect(PROTOCOL_LABEL.meridian).toBe("Meridian");
  });

  it("returns undefined for an unknown key (the fallback contract)", () => {
    expect(PROTOCOL_LABEL.unknown).toBeUndefined();
    // The fallback (e.g. capitalize the key) must be applied by the caller — this
    // test asserts the map itself doesn't fabricate a label for keys it doesn't know.
    expect(PROTOCOL_LABEL["nonexistent"]).toBeUndefined();
  });

  it("exposes every expected protocol key", () => {
    // Assert the registry shape stays stable. Adding a new protocol entry is fine,
    // but each currently-known key must still resolve to a non-empty string.
    const expectedKeys = ["blend", "defindex", "meridian"];
    for (const key of expectedKeys) {
      expect(PROTOCOL_LABEL[key]).toBeTruthy();
      expect(typeof PROTOCOL_LABEL[key]).toBe("string");
    }
  });
});
