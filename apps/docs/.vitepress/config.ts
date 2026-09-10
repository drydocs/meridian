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
    // Meridian's own convergence mark (three arcs sharing one center — see
    // /overview/brand-guidelines), not a borrowed protocol icon.
    logo: {
      svg: '<svg viewBox="4 4 32 17" xmlns="http://www.w3.org/2000/svg" fill="none"><defs><linearGradient id="meridian-convergence-nav" x1="34" y1="20" x2="17" y2="17" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#10b981"/></linearGradient></defs><path d="M34 20 A14 14 0 0 0 6 20 A11 11 0 0 1 28 20 A8 8 0 0 0 12 20 A5 5 0 0 1 22 20" stroke="url(#meridian-convergence-nav)" stroke-width="2.25" stroke-linecap="butt"/><circle cx="17" cy="17.3" r="2.6" fill="url(#meridian-convergence-nav)"/></svg>',
    },
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
    footer: {
      message: "Open source on Stellar.",
      copyright: "MIT License",
    },
    search: {
      provider: "local",
    },
  },
});
