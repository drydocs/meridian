import { describe, expect, it, vi } from "vitest";
import { NetworkError } from "./errors.js";
import {
  REDACTED,
  redact,
  redactString,
  safeCall,
  sanitizeError,
} from "./instrumentation.js";

const SECRET = "S" + "A".repeat(55);

describe("redactString", () => {
  it("scrubs Stellar secret seeds", () => {
    expect(redactString(`key ${SECRET} leaked`)).toBe(`key ${REDACTED} leaked`);
  });

  it("keeps only the host of URLs, dropping userinfo, path and query", () => {
    const out = redactString(
      "GET https://user:pw@rpc.example.com/v1/KEY123?apikey=abc failed"
    );
    expect(out).not.toMatch(/KEY123|apikey|user|pw@/);
    expect(out).toContain("rpc.example.com");
  });

  it("scrubs bearer tokens and long base64 blobs", () => {
    expect(redactString("Authorization: Bearer abc.def-ghi")).not.toContain(
      "abc"
    );
    expect(redactString(`xdr ${"A".repeat(200)}`)).toBe(`xdr ${REDACTED}`);
  });

  it("leaves public addresses alone", () => {
    const g = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    expect(redactString(g)).toBe(g);
  });
});

describe("redact", () => {
  it("redacts sensitive keys at any depth and stringifies bigints", () => {
    const out = redact({
      assets: 5n,
      secretKey: "x",
      nested: { apiKey: "k", Authorization: "a", xdr: "AAAA", ok: 1 },
      list: [{ password: "p" }, SECRET],
    }) as {
      assets: string;
      secretKey: string;
      nested: unknown;
      list: unknown;
    };
    expect(out.assets).toBe("5");
    expect(out.secretKey).toBe(REDACTED);
    expect(out.nested).toEqual({
      apiKey: REDACTED,
      Authorization: REDACTED,
      xdr: REDACTED,
      ok: 1,
    });
    expect(out.list).toEqual([{ password: REDACTED }, REDACTED]);
  });

  it("handles cycles, errors and functions", () => {
    const a: Record<string, unknown> = { fn: () => 1 };
    a.self = a;
    const out = redact({ a, e: new Error(`boom ${SECRET}`) }) as {
      a: { self: unknown; fn: unknown };
      e: unknown;
    };
    expect(out.a.self).toBe(REDACTED);
    expect(out.a.fn).toBeUndefined();
    expect(out.e).toEqual({ name: "Error", message: `boom ${REDACTED}` });
  });

  it("does not mutate its input", () => {
    const input = { secret: "x", n: 1n };
    redact(input);
    expect(input).toEqual({ secret: "x", n: 1n });
  });
});

describe("sanitizeError", () => {
  it("exposes code/retryable and a one-line scrubbed message, never the cause", () => {
    const e = new NetworkError(`down at https://rpc.x/KEY\nsecond ${SECRET}`, {
      cause: new Error("raw"),
    });
    const s = sanitizeError(e);
    expect(s).toEqual({
      name: "NetworkError",
      code: "NETWORK",
      retryable: true,
      message: expect.not.stringMatching(/KEY|second/),
    });
    expect(s).not.toHaveProperty("cause");
  });
});

describe("safeCall", () => {
  it("swallows sync throws and async rejections", async () => {
    expect(() =>
      safeCall(() => {
        throw new Error("x");
      }, {})
    ).not.toThrow();
    const unhandled = vi.fn();
    process.once("unhandledRejection", unhandled);
    safeCall(async () => {
      throw new Error("y");
    }, {});
    await new Promise((r) => setTimeout(r, 10));
    expect(unhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", unhandled);
  });

  it("ignores a missing hook", () => {
    expect(() => safeCall(undefined, {})).not.toThrow();
  });
});
