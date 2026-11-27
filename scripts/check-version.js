#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");

// 1. Check Node.js version against pinned version (.node-version)
const nodeVersionPath = path.join(rootDir, ".node-version");
let expectedNodeMajor = 22;

if (fs.existsSync(nodeVersionPath)) {
  const content = fs.readFileSync(nodeVersionPath, "utf8").trim();
  const parsed = parseInt(content.replace(/^v/, ""), 10);
  if (!Number.isNaN(parsed)) {
    expectedNodeMajor = parsed;
  }
}

const currentNodeVersion = process.versions.node;
const currentNodeMajor = parseInt(currentNodeVersion.split(".")[0], 10);

if (currentNodeMajor !== expectedNodeMajor) {
  console.error(
    `\n\x1b[31m[error]\x1b[0m Unsupported Node.js version: v${currentNodeVersion}\n` +
      `Expected Node.js major version ${expectedNodeMajor} (as specified in .node-version).\n` +
      `Please switch to Node.js ${expectedNodeMajor}.x (e.g. using 'nvm use' or 'fnm use') and retry.\n`
  );
  process.exit(1);
}

// 2. Check Package Manager (pnpm) version against package.json
let expectedPnpmMajor = 9;
try {
  const packageJsonPath = path.join(rootDir, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    if (pkg.packageManager) {
      const match = pkg.packageManager.match(/^pnpm@(\d+)\./);
      if (match) {
        expectedPnpmMajor = parseInt(match[1], 10);
      }
    }
  }
} catch {
  // fallback to default expectedPnpmMajor
}

const userAgent = process.env.npm_config_user_agent || "";

if (userAgent) {
  if (!userAgent.startsWith("pnpm/")) {
    const pmName = userAgent.split(" ")[0].split("/")[0] || "Unknown";
    console.error(
      `\n\x1b[31m[error]\x1b[0m Unsupported package manager: ${pmName}\n` +
        `This repository requires pnpm ${expectedPnpmMajor}.x.\n` +
        `Please install pnpm and run 'pnpm install'.\n`
    );
    process.exit(1);
  }

  const pnpmMatch = userAgent.match(/^pnpm\/(\d+)\./);
  if (pnpmMatch) {
    const currentPnpmMajor = parseInt(pnpmMatch[1], 10);
    if (currentPnpmMajor !== expectedPnpmMajor) {
      const currentPnpmVersion = userAgent.split(" ")[0].replace("pnpm/", "");
      console.error(
        `\n\x1b[31m[error]\x1b[0m Unsupported pnpm version: ${currentPnpmVersion}\n` +
          `Expected pnpm major version ${expectedPnpmMajor} (as specified in package.json packageManager).\n` +
          `Please install pnpm ${expectedPnpmMajor}.x and retry.\n`
      );
      process.exit(1);
    }
  }
}
