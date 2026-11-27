# Mobile Lighthouse baseline (#1428)

`mobile-baseline.json` is a point-in-time, throttled mobile Lighthouse run of
the rebuilt dashboard shell. It is a reference for catching material
regressions, not a hard CI gate: Lighthouse scores move with machine load,
Chrome version, and the live APIs the dashboard calls.

## Capture settings

- Production build (`pnpm --filter @meridian/web build`) served by
  `pnpm --filter @meridian/web preview`.
- URL: `http://localhost:3000/app/`
- Form factor: mobile
- Emulated screen: 390 x 844 CSS pixels, DPR 3 (the 390px viewport from the
  issue; the mobile Playwright suite covers 320, 360, and 390).
- Simulated throttling: 150 ms RTT, 1.6 Mbps downlink, 4x CPU slowdown
  (Lighthouse's default mobile throttling profile).

## Reproduce

```bash
pnpm --filter @meridian/web build
pnpm --filter @meridian/web preview
```

In another terminal (set `CHROME_PATH` if Chrome is not auto-detected):

```bash
npx --yes lighthouse@12.8.2 http://localhost:3000/app/ \
  --form-factor=mobile \
  --throttling-method=simulate \
  --screenEmulation.mobile=true \
  --screenEmulation.width=390 \
  --screenEmulation.height=844 \
  --screenEmulation.deviceScaleFactor=3 \
  --output=json \
  --output-path=/tmp/mobile-lighthouse.json \
  --quiet

node apps/web/scripts/summarize-lighthouse.mjs /tmp/mobile-lighthouse.json \
  > apps/web/lighthouse/mobile-baseline.json
```

`scripts/summarize-lighthouse.mjs` keeps only the metadata, category scores,
and core metrics instead of checking in Lighthouse's full multi-megabyte
report.

## Current baseline

| Category       | Score |
| -------------- | ----: |
| Performance    |  0.94 |
| Accessibility  |  0.98 |
| Best practices |  0.96 |
| SEO            |     1 |

| Metric                   |  Value |
| ------------------------ | -----: |
| First Contentful Paint   |   2.1s |
| Largest Contentful Paint |   2.2s |
| Total Blocking Time      |  160ms |
| Cumulative Layout Shift  |  0.073 |
| Speed Index              |   2.1s |
| Time to Interactive      |   2.4s |
| Total byte weight        | 162KiB |

The preview server has no API proxy, so API-backed rows render their empty or
failure states; this baseline measures the dashboard layout and startup cost,
which is what the mobile rebuild changed. The Playwright mobile suite
(`apps/web/e2e/mobile-dashboard.spec.ts`) covers the interactive connected
states at 320, 360, and 390 pixels.

## Refreshing

Re-run the capture after a material layout, CSS, or bundle change and include
the score/metric diff in the PR description. Do not refresh it just to make a
regression disappear; explain the change.
