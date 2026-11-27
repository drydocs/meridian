import { describe, expect, it } from "vitest";
import { createStrongETag, ifNoneMatchMatches } from "../_lib/etag.js";

describe("createStrongETag", () => {
  it("returns a stable quoted SHA-256 tag for the exact body", () => {
    const body = '{"vaults":[]}';
    const etag = createStrongETag(body);

    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(createStrongETag(body)).toBe(etag);
    expect(createStrongETag('{"vaults":[1]}')).not.toBe(etag);
  });
});

describe("ifNoneMatchMatches", () => {
  const etag = '"0123456789abcdef"';

  it("matches a wildcard", () => {
    expect(ifNoneMatchMatches("*", etag)).toBe(true);
  });

  it("matches a tag in a comma-separated list", () => {
    expect(ifNoneMatchMatches(`"other", ${etag}`, etag)).toBe(true);
  });

  it("uses weak comparison for weak-prefixed tags", () => {
    expect(ifNoneMatchMatches(`W/${etag}`, etag)).toBe(true);
  });

  it("does not match malformed or empty headers", () => {
    for (const header of [undefined, "", " \t ", "not-a-tag", 'W/"open']) {
      expect(ifNoneMatchMatches(header, etag)).toBe(false);
    }
  });
});
