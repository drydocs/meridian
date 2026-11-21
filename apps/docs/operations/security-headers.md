# Web security headers

Vercel sets the global baseline headers in `vercel.json`. Landing and docs
responses receive separate `Content-Security-Policy-Report-Only` policies;
neither policy is enforced yet. The broader report-only policy on the global
header rule also covers generated 404s and other paths without a more specific
policy. `/app` and `/admin` keep their existing enforced CSP, and API responses
continue to use `default-src 'none'`.

## Route policies

| Route group                        | Resource permissions                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/` and `/index.html` (landing)    | Same-origin scripts and images, the inline counter script and stylesheet by SHA-256, Google Fonts CSS from `fonts.googleapis.com`, and font files from `fonts.gstatic.com`. Data images are allowed for the landing page's noise texture. Network connections, frames, objects, and inline event handlers are not allowed. |
| `/docs/` (VitePress documentation) | Same-origin scripts, styles, fonts, images, and local-search requests. The two VitePress startup scripts and generated hash-map script are pinned by SHA-256. No external scripts, fonts, or connections are needed; external hyperlinks do not need CSP permissions.                                                      |
| `/app` and `/admin`                | The existing enforced policy is unchanged.                                                                                                                                                                                                                                                                                 |
| API routes                         | `default-src 'none'` remains enforced for JSON responses.                                                                                                                                                                                                                                                                  |

The docs use Shiki syntax highlighting, which renders many code-token colors
as `style` attributes. The docs policy therefore permits inline **style
attributes only** with `style-src-attr 'unsafe-inline'`; inline style elements
remain disallowed. The global report-only fallback uses the same narrowly
scoped exception so these generated code styles are not reported as violations.
The landing page permits neither inline style attributes nor inline event
handlers.

Landing-page hashes cover the contents of its single inline `<style>` and
`<script>` elements. Docs hashes cover VitePress's two startup scripts and its
generated client-side hash-map script, whose contents change when the docs
pages change. The Vercel build runs `scripts/check-csp-hashes.mjs` against every
generated HTML page to detect stale hashes. Do not replace a hash with
`unsafe-inline` in `script-src`.

Landing and docs also set `Permissions-Policy` to disable camera, microphone,
and geolocation, `Cross-Origin-Opener-Policy: same-origin`, and
`Cross-Origin-Resource-Policy: same-origin`. These routes do not need popup
wallet flows or cross-origin embedded resources; reassess these values before
adding such functionality. Existing `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, and HSTS headers remain in place.

## Reporting and monitoring

Report-only policies send violations to `/api/v1/csp-report` using CSP's
`report-uri` mechanism. The endpoint accepts legacy CSP reports and
Reporting-API `csp-violation` batches, capped at five entries and 8 KiB per
request. It validates the content type and report shape, applies the shared
rate limit, and logs only the normalized directive, disposition, and HTTP
status code. Document URLs, blocked URLs, referrers, and sample content are
never logged. Responses are not cached. A distributed Upstash rate-limit
backend must be configured on deployed environments; the endpoint returns
`503` rather than accepting unbounded logging if it is unavailable. Local
processes without `VERCEL_ENV` use the existing in-memory fallback; `vercel
dev` sets a Vercel environment and therefore also needs the distributed
backend.

Review the Vercel function logs for `[csp-report]` entries during rollout.
Restrict log access and retention in the Vercel project, and create an alert
for sustained or unusual report volume. The endpoint's response is JSON with
the API's existing restrictive CSP; it does not reflect report data.

Before promoting a preview, run
`SECURITY_HEADERS_BASE_URL=https://<preview-origin> pnpm test:security-headers`.
This makes HTTP requests to landing, docs, app, admin, the API, a redirect, and
an unknown route, and checks their status codes and returned headers.

## Moving to enforcement

Keep landing and docs in report-only mode through a representative release
cycle. Review production reports, distinguish expected browser extensions or
network filtering from application requirements, and update a policy only for
a verified first-party dependency. Rebuild docs and recalculate any changed
hashes. Test the final policy on a preview deployment before changing the
route's header name from `Content-Security-Policy-Report-Only` to
`Content-Security-Policy`. Enforce landing and docs independently, retain
reporting during the transition where supported, and monitor errors and reports
after each change. Do not change the existing `/app`, `/admin`, or API policies
as part of this rollout.
