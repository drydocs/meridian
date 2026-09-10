import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Meridian",
  description:
    "Stablecoin yield aggregator on Stellar, built for emerging market savers.",
  base: "/docs/",
  vite: { server: { port: 3002 } },
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
      { text: "App", link: "https://meridian-web.vercel.app/app/" },
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
          { text: "Vault Contract", link: "/architecture/vault-contract" },
          { text: "Signing Flow", link: "/architecture/signing-flow" },
        ],
      },
      {
        text: "Operations",
        items: [
          { text: "Local Development", link: "/operations/local-development" },
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
