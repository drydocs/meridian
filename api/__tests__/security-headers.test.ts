import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

const root = new URL("../../", import.meta.url);
const rules: HeaderRule[] = JSON.parse(
  readFileSync(new URL("vercel.json", root), "utf8")
).headers;

function rule(source: string): Record<string, string> {
  const match = rules.find((entry) => entry.source === source);
  if (!match) throw new Error(`vercel.json has no header rule for ${source}`);
  return Object.fromEntries(match.headers.map((h) => [h.key, h.value]));
}

function need(headers: Record<string, string>, key: string): string {
  const value = headers[key];
  if (value === undefined) throw new Error(`missing header ${key}`);
  return value;
}

function directive(policy: string, name: string): string {
  const found = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  if (found === undefined) throw new Error(`policy has no ${name} directive`);
  return found;
}

function inlineHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(
    /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1>/gi
  )) {
    const [, tag = "", attrs = "", body = ""] = match;
    if (tag.toLowerCase() === "script" && /\bsrc\s*=/.test(attrs)) continue;
    hashes.push(
      `'sha256-${createHash("sha256").update(body).digest("base64")}'`
    );
  }
  return hashes;
}

const ROUTE_HEADERS = {
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

describe("vercel.json security headers", () => {
  it("applies the baseline headers and CSP reporting to every route", () => {
    const headers = rule("/(.*)");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Strict-Transport-Security"]).toMatch(/max-age=63072000/);
    expect(headers["Content-Security-Policy-Report-Only"]).toContain(
      "report-uri /api/v1/csp-report"
    );
  });

  it("keeps /app and /admin on the existing enforced policy", () => {
    const headers = rule("/:base(app|admin)/:path*");
    const policy = need(headers, "Content-Security-Policy");
    // Enforced, not report-only, and still free of the relaxations the docs
    // and landing policies are deliberately narrower than.
    expect(headers["Content-Security-Policy-Report-Only"]).toBeUndefined();
    expect(directive(policy, "script-src")).toBe("script-src 'self'");
    expect(policy).not.toContain("unsafe-eval");
    expect(directive(policy, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(policy, "object-src")).toBe("object-src 'none'");
    // The landing/docs headers must not leak onto the app routes.
    for (const key of Object.keys(ROUTE_HEADERS)) {
      expect(headers[key]).toBeUndefined();
    }
  });

  describe.each(["/", "/index.html"])("landing page %s", (source) => {
    const headers = rule(source);
    const policy = need(headers, "Content-Security-Policy-Report-Only");

    it("sets the permissions, COOP and CORP headers", () => {
      for (const [key, value] of Object.entries(ROUTE_HEADERS)) {
        expect(headers[key]).toBe(value);
      }
    });

    it("has a dedicated report-only policy without unsafe-eval or inline scripts", () => {
      expect(policy).toContain("form-action 'self'");
      expect(policy).toContain("report-uri /api/v1/csp-report");
      expect(policy).not.toContain("unsafe-eval");
      expect(directive(policy, "script-src")).not.toContain("unsafe-inline");
      expect(directive(policy, "style-src-attr")).toBe("style-src-attr 'none'");
      expect(directive(policy, "style-src")).toContain(
        "https://fonts.googleapis.com"
      );
      expect(directive(policy, "font-src")).toContain(
        "https://fonts.gstatic.com"
      );
    });

    it("pins a hash for every inline script and style in apps/landing/index.html", () => {
      const html = readFileSync(
        new URL("apps/landing/index.html", root),
        "utf8"
      );
      const hashes = inlineHashes(html);
      expect(hashes.length).toBeGreaterThan(0);
      for (const hash of hashes) expect(policy).toContain(hash);
    });
  });

  describe("docs /docs/:path*", () => {
    const headers = rule("/docs/:path*");
    const policy = need(headers, "Content-Security-Policy-Report-Only");

    it("sets the permissions, COOP and CORP headers", () => {
      for (const [key, value] of Object.entries(ROUTE_HEADERS)) {
        expect(headers[key]).toBe(value);
      }
    });

    it("has a dedicated, narrow report-only policy", () => {
      expect(policy).toContain("report-uri /api/v1/csp-report");
      expect(policy).not.toContain("unsafe-eval");
      expect(policy).not.toContain("fonts.googleapis.com");
      expect(directive(policy, "script-src")).not.toContain("unsafe-inline");
      expect(directive(policy, "frame-ancestors")).toBe(
        "frame-ancestors 'none'"
      );
      expect(directive(policy, "object-src")).toBe("object-src 'none'");
    });

    it("only pins the stable VitePress inline scripts, not the per-build hash map", () => {
      // The hash map changes with every docs edit; apps/docs/.vitepress/config.ts
      // serves it as an external script so it never needs a CSP hash.
      expect(policy.match(/'sha256-[^']+'/g)).toHaveLength(2);
    });
  });
});
