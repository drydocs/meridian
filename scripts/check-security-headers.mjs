import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const baseUrl = process.env.SECURITY_HEADERS_BASE_URL;
if (!baseUrl) {
  throw new Error(
    "Set SECURITY_HEADERS_BASE_URL to the Vercel deployment or local Vercel dev URL to run this smoke test."
  );
}

const base = new URL(baseUrl);
if (
  !["https:", "http:"].includes(base.protocol) ||
  base.username ||
  base.password ||
  base.pathname !== "/" ||
  base.search ||
  base.hash
) {
  throw new Error("SECURITY_HEADERS_BASE_URL must be an origin URL.");
}
const isLocal =
  base.hostname === "localhost" ||
  base.hostname === "::1" ||
  base.hostname === "[::1]" ||
  /^127(?:\.\d{1,3}){3}$/.test(base.hostname);

// The app/admin policy is whatever vercel.json enforces for those routes, so
// legitimate edits (for example new connect-src hosts) do not break this check.
const vercelConfig = JSON.parse(
  readFileSync(new URL("../vercel.json", import.meta.url), "utf8")
);
const appPolicy = vercelConfig.headers
  .find((entry) => entry.source === "/:base(app|admin)/:path*")
  ?.headers.find((header) => header.key === "Content-Security-Policy")?.value;
assert.ok(appPolicy, "vercel.json must define the app/admin policy");

async function request(path, init = {}) {
  return fetch(new URL(path, base), {
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    ...init,
  });
}

function assertBaselineHeaders(response) {
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(
    response.headers.get("referrer-policy"),
    "strict-origin-when-cross-origin"
  );
  assert.match(
    response.headers.get("strict-transport-security") ?? "",
    /max-age=63072000/
  );
  assert.match(
    response.headers.get("content-security-policy-report-only") ?? "",
    /report-uri \/api\/v1\/csp-report/
  );
}

function assertRouteHeaders(response) {
  assert.equal(
    response.headers.get("permissions-policy"),
    "camera=(), microphone=(), geolocation=()"
  );
  assert.equal(
    response.headers.get("cross-origin-opener-policy"),
    "same-origin"
  );
  assert.equal(
    response.headers.get("cross-origin-resource-policy"),
    "same-origin"
  );
}

function reportOnlyPolicies(response) {
  return (response.headers.get("content-security-policy-report-only") ?? "")
    .split(/,\s*(?=default-src)/)
    .map((policy) => policy.trim());
}

async function assertHtml(path, policyCheck) {
  const response = await request(path);
  assert.equal(response.status, 200, `${path} should return HTTP 200`);
  assert.match(
    response.headers.get("content-type") ?? "",
    /text\/html/i,
    `${path} should return HTML`
  );
  assertBaselineHeaders(response);
  assertRouteHeaders(response);
  policyCheck(reportOnlyPolicies(response));
  return response;
}

const landingPolicy = (policies) => {
  const policy = policies.find(
    (value) =>
      value.includes("form-action 'self'") &&
      value.includes("style-src-attr 'none'")
  );
  assert.ok(policy, "landing should receive its dedicated report-only policy");
  assert.match(
    policy,
    /sha256-WdxMG\+bu8T\+Derz02Av31p3fbfeL5L\/jepusFRDcpjI=/
  );
  assert.match(policy, /sha256-NJ0izZB7cNaFZ4xXmpU4DPQSnBsjoIUNTUphmLjwpeU=/);
  assert.match(policy, /https:\/\/fonts\.googleapis\.com/);
  assert.match(policy, /https:\/\/fonts\.gstatic\.com/);
  assert.doesNotMatch(policy, /unsafe-eval/);
  assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/);
};

const docsPolicy = (policies) => {
  const policy = policies.find((value) =>
    value.includes("style-src 'self'; style-src-attr 'unsafe-inline'")
  );
  assert.ok(policy, "docs should receive their dedicated report-only policy");
  assert.match(policy, /sha256-DQUgNM9X0iH2019NkUxeBvnBoEoRKkHBc\/I0iLqPNPA=/);
  assert.match(policy, /sha256-La1r0VSk0Po4KFI0duEKhmPu\+u0I416JW3oONqtdf4M=/);
  assert.doesNotMatch(policy, /https:\/\/fonts\.googleapis\.com/);
  assert.doesNotMatch(policy, /unsafe-eval/);
};

await assertHtml("/", landingPolicy);
await assertHtml("/index.html", landingPolicy);
await assertHtml("/docs/", docsPolicy);
await assertHtml("/docs/overview/introduction", docsPolicy);

for (const path of ["/app", "/app/", "/admin", "/admin/"]) {
  const response = await request(path);
  assert.equal(response.status, 200, `${path} should return HTTP 200`);
  assertBaselineHeaders(response);
  assert.equal(
    response.headers.get("content-security-policy"),
    appPolicy,
    `${path} should retain the existing app policy`
  );
}

const apiReport = await request("/api/v1/csp-report", {
  method: "POST",
  headers: { "content-type": "application/csp-report" },
  body: "{",
});
assert.ok(
  apiReport.status === 400 || (isLocal && apiReport.status === 503),
  `Unexpected CSP report endpoint status: ${apiReport.status}`
);
assertBaselineHeaders(apiReport);
assert.equal(
  apiReport.headers.get("content-security-policy"),
  "default-src 'none'",
  "the API must retain its restrictive CSP"
);
if (apiReport.status === 503) {
  assert.equal(
    (await apiReport.json()).code,
    "RATE_LIMIT_BACKEND_UNAVAILABLE",
    "local Vercel dev needs Upstash credentials to pass the distributed limiter"
  );
}

const redirect = await request("/app/admin/");
assert.ok([301, 302, 307, 308].includes(redirect.status));
assert.equal(
  new URL(redirect.headers.get("location"), base).pathname,
  "/admin/"
);
assertBaselineHeaders(redirect);

const missing = await request("/__security_headers_not_found__");
assert.equal(missing.status, 404);
assertBaselineHeaders(missing);

console.log(
  "Security header smoke test passed for landing, docs, app, admin, API, redirects, and 404."
);
