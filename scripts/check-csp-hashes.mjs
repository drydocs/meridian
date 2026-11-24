import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const vercelConfig = JSON.parse(
  readFileSync(join(root, "vercel.json"), "utf8")
);

function policyFor(source) {
  const route = vercelConfig.headers.find((entry) => entry.source === source);
  const policy = route?.headers.find(
    (header) => header.key === "Content-Security-Policy-Report-Only"
  )?.value;
  assert.ok(policy, `Missing report-only CSP for ${source}`);
  return policy;
}

function extractHashes(html, label) {
  const hashes = new Set();
  for (const match of html.matchAll(
    /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1>/gi
  )) {
    if (match[1].toLowerCase() === "script" && /\bsrc\s*=/.test(match[2])) {
      continue;
    }
    const hash = createHash("sha256").update(match[3]).digest("base64");
    hashes.add(`'sha256-${hash}'`);
  }
  assert.ok(hashes.size > 0, `No inline scripts or styles found in ${label}`);
  return hashes;
}

function assertPolicyHashes(policy, hashes, label) {
  for (const hash of hashes) {
    assert.ok(policy.includes(hash), `${label} CSP is missing ${hash}`);
  }
}

function htmlFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...htmlFiles(path));
    else if (path.endsWith(".html")) files.push(path);
  }
  return files;
}

const landingHtml = readFileSync(join(root, "apps/landing/index.html"), "utf8");
assertPolicyHashes(
  policyFor("/"),
  extractHashes(landingHtml, "landing index"),
  "Landing"
);
assertPolicyHashes(
  policyFor("/index.html"),
  extractHashes(landingHtml, "landing index"),
  "Landing /index.html"
);

const docsDirectory = join(root, "apps/docs/.vitepress/dist");
const docsHashes = new Set();
const pages = htmlFiles(docsDirectory);
assert.ok(pages.length > 0, "Docs must be built before checking CSP hashes");
for (const page of pages) {
  for (const hash of extractHashes(readFileSync(page, "utf8"), page)) {
    docsHashes.add(hash);
  }
}
assertPolicyHashes(policyFor("/docs/:path*"), docsHashes, "Docs");

console.log(
  `CSP hash check passed for landing and ${pages.length} generated docs pages.`
);
