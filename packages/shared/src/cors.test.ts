import { describe, expect, it } from "vitest";
import { parseAllowedOrigins } from "./cors";

describe("parseAllowedOrigins", () => {
  it("uses the default when no value is configured", () => {
    expect(parseAllowedOrigins(undefined, "https://app.example")).toEqual([
      "https://app.example",
    ]);
  });

  it("splits, trims, and de-duplicates configured origins", () => {
    expect(
      parseAllowedOrigins(
        " https://app.example, https://preview.example,https://app.example ",
        "https://fallback.example"
      )
    ).toEqual(["https://app.example", "https://preview.example"]);
  });

  it("rejects wildcard values", () => {
    expect(() =>
      parseAllowedOrigins("https://app.example, *", "fallback")
    ).toThrow(/wildcard/);
    expect(() => parseAllowedOrigins("https://*.example", "fallback")).toThrow(
      /wildcard/
    );
  });
});
