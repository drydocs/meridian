import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json";
import fr from "../../../messages/fr.json";

describe("freshness and connectivity translations", () => {
  it("defines the required labels in both supported locales", () => {
    for (const locale of [en, fr]) {
      expect(locale.status.stale).toBeTruthy();
      expect(locale.status.lastUpdated).toBeTruthy();
      expect(locale.status.offlineBanner).toBeTruthy();
    }
  });
});
