import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vitepress";

// VitePress inlines `window.__VP_HASH_MAP__=...` in every page. The map lists a
// content hash per docs page, so an inline CSP hash for it would change on any
// docs edit. Emit it as a content-hashed external script instead, which the
// docs `script-src 'self'` policy already allows.
const HASH_MAP_SCRIPT = /<script>(window\.__VP_HASH_MAP__=[\s\S]*?)<\/script>/;
const hashMapScripts = new Map<string, string>();

export default defineConfig({
  title: "Meridian",
  description:
    "Stablecoin yield aggregator on Stellar, built for emerging market savers.",
  base: "/docs/",
  vite: { server: { port: 3002 } },
  transformHtml(code) {
    const match = HASH_MAP_SCRIPT.exec(code);
    if (!match) return;
    const source = match[1];
    const name = `vp-hash-map.${createHash("sha256").update(source).digest("hex").slice(0, 8)}.js`;
    hashMapScripts.set(name, source);
    return code.replace(
      match[0],
      `<script src="/docs/assets/${name}"></script>`
    );
  },
  buildEnd(siteConfig) {
    const assets = join(siteConfig.outDir, "assets");
    mkdirSync(assets, { recursive: true });
    for (const [name, source] of hashMapScripts) {
      writeFileSync(join(assets, name), `${source}\n`);
    }
  },
  head: [
    [
      "link",
      { rel: "icon", type: "image/svg+xml", href: "/docs/logo-mark.svg" },
    ],
  ],
  themeConfig: {
    // `logo` only accepts a path/src; an inline `{ svg: ... }` key is
    // silently ignored (see vitepress/types/default-theme.d.ts).
    logo: "/logo-mark.svg",
    nav: [
      { text: "Overview", link: "/overview/introduction" },
      { text: "Architecture", link: "/architecture/monorepo" },
      { text: "Operations", link: "/operations/local-development" },
      { text: "App", link: "https://usemeridian.vercel.app" },
      { text: "GitHub", link: "https://github.com/drydocs/meridian" },
    ],
    sidebar: [
      {
        text: "Overview",
        items: [
          { text: "Introduction", link: "/overview/introduction" },
          { text: "Why Meridian", link: "/overview/why-meridian" },
          { text: "How It Works", link: "/overview/how-it-works" },
          { text: "Trust Model", link: "/overview/trust-model" },
          { text: "Brand Guidelines", link: "/overview/brand-guidelines" },
        ],
      },
      {
        text: "Architecture",
        items: [
          { text: "Monorepo Structure", link: "/architecture/monorepo" },
          { text: "Frontend", link: "/architecture/frontend" },
          { text: "API Layer", link: "/architecture/api" },
          { text: "API Error Reference", link: "/architecture/api-errors" },
          { text: "Vault Contract", link: "/architecture/vault-contract" },
          {
            text: "Contract Storage and TTL",
            link: "/architecture/contract-storage",
          },
          { text: "Contract Errors", link: "/architecture/contract-errors" },
          { text: "Signing Flow", link: "/architecture/signing-flow" },
          { text: "Architecture Decision Records", link: "/architecture/adr/" },
        ],
      },
      {
        text: "Strategies",
        items: [
          {
            text: "Strategies App Guide",
            link: "/strategies/app",
          },
          {
            text: "Architecture Overview",
            link: "/strategies/architecture",
          },
          {
            text: "Custom Strategy Tutorial",
            link: "/strategies/custom-strategy",
          },
          {
            text: "Delta-Neutral Strategy",
            link: "/strategies/delta-neutral",
          },
          {
            text: "Self-Repaying Loan Strategy",
            link: "/strategies/self-repaying-loan",
          },
          {
            text: "Strategy Composition Guide",
            link: "/strategies/composition",
          },
          { text: "Risk Metrics", link: "/strategies/risk-metrics" },
        ],
      },
      {
        text: "Operations",
        items: [
          { text: "Local Development", link: "/operations/local-development" },
          {
            text: "Contract Storage and TTL",
            link: "/architecture/contract-storage",
          },
          {
            text: "Testnet Deployment",
            link: "/operations/testnet-deployment",
          },
          {
            text: "Mainnet Deployment",
            link: "/operations/mainnet-deployment",
          },
          {
            text: "Environment Variables",
            link: "/operations/environment-variables",
          },
          {
            text: "Blend Accrual Keeper",
            link: "/operations/accrual-keeper",
          },
          {
            text: "Migration Keeper",
            link: "/operations/migration-keeper",
          },
          {
            text: "Admin-Event Alert Keeper",
            link: "/operations/alert-keeper",
          },
          {
            text: "Incident Response",
            link: "/operations/incident-response",
          },
          {
            text: "Outage Recovery",
            link: "/operations/outage-recovery",
          },
          {
            text: "Wallet Signing Troubleshooting",
            link: "/operations/wallet-signing-troubleshooting",
          },
          {
            text: "Security Headers",
            link: "/operations/security-headers",
          },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/drydocs/meridian" },
    ],
    search: {
      provider: "local",
    },
  },
});
