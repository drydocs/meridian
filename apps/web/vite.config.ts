import { readFileSync } from "fs";
import { resolve } from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/vite-plugin";

const webPackage = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf8")
) as { name: string; version: string };
const appVersion =
  process.env.SENTRY_RELEASE ??
  process.env.VERCEL_GIT_COMMIT_SHA ??
  `${webPackage.name}@${webPackage.version}`;
const hasSentryUploadConfig = Boolean(
  process.env.SENTRY_AUTH_TOKEN &&
  process.env.SENTRY_ORG &&
  process.env.SENTRY_PROJECT
);
const sentryUploadConfig = [
  process.env.SENTRY_AUTH_TOKEN,
  process.env.SENTRY_ORG,
  process.env.SENTRY_PROJECT,
].some(Boolean);

const serveLanding = {
  name: "serve-landing",
  configureServer(server: import("vite").ViteDevServer) {
    server.middlewares.use((req, res, next) => {
      if (req.url === "/" || req.url === "") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(readFileSync(resolve(__dirname, "../landing/index.html")));
        return;
      }
      next();
    });
  },
};

export default defineConfig(({ command }) => {
  if (command === "build" && sentryUploadConfig && !hasSentryUploadConfig) {
    throw new Error(
      "Sentry source-map upload requires SENTRY_AUTH_TOKEN, SENTRY_ORG, and SENTRY_PROJECT."
    );
  }

  const sentryUploadEnabled = command === "build" && hasSentryUploadConfig;

  return {
    plugins: [
      react(),
      ...(sentryUploadEnabled
        ? [
            sentryVitePlugin({
              authToken: process.env.SENTRY_AUTH_TOKEN,
              org: process.env.SENTRY_ORG,
              project: process.env.SENTRY_PROJECT,
              release: { name: appVersion },
              sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] },
            }),
          ]
        : []),
      serveLanding,
    ],
    base: "/app/",
    build: {
      sourcemap: sentryUploadEnabled ? "hidden" : false,
    },
    // packages/shared's dist/constants.ts reads process.env.STELLAR_NETWORK for
    // its Node-side (API) consumers. In dev, Vite serves that pre-built file to
    // the browser as-is (via @fs/) rather than replacing process.env
    // references, so `process` is genuinely undefined at runtime and the app
    // fails to boot; defining it as an empty object there matches Node's own
    // `undefined` lookup behavior for unset vars (constants.ts already falls
    // back to "testnet" in that case). A production build needs the real
    // value inlined instead: replacing it with an empty object here too meant
    // the shipped frontend bundle always resolved to testnet regardless of
    // what STELLAR_NETWORK was actually set to at build time, independent of
    // any Vercel project setting.
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion),
      "process.env":
        command === "serve"
          ? "{}"
          : JSON.stringify({ STELLAR_NETWORK: process.env.STELLAR_NETWORK }),
    },
    server: {
      port: 3000,
      strictPort: true,
      proxy: {
        "/api": {
          target: "http://localhost:3001",
          changeOrigin: true,
        },
        "/docs": {
          target: "http://localhost:3002",
          changeOrigin: true,
        },
      },
    },
    preview: {
      port: 3000,
    },
  };
});
