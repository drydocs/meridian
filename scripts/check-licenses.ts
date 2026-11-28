#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface LicenseException {
  name: string;
  license: string;
  owner: string;
  expires: string;
}

interface LicenseAllowlist {
  allowed: string[];
  exceptions: LicenseException[];
}

interface JavaScriptPackage {
  name: string;
  versions?: string[];
  license?: string;
}

interface RustPackage {
  name: string;
  version: string;
  license: string | null;
  license_file: string | null;
  source: string | null;
}

interface CargoMetadata {
  packages: RustPackage[];
}

const REPO_ROOT = join(__dirname, "..");
const CONTRACTS_DIR = join(REPO_ROOT, "packages", "contracts");
const ALLOWLIST_PATH = join(__dirname, "license-allowlist.json");
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const CARGO = process.platform === "win32" ? "cargo.exe" : "cargo";

function loadAllowlist(): LicenseAllowlist {
  const parsed = JSON.parse(
    readFileSync(ALLOWLIST_PATH, "utf8")
  ) as LicenseAllowlist;
  if (!Array.isArray(parsed.allowed) || !Array.isArray(parsed.exceptions)) {
    throw new Error(
      "license-allowlist.json must contain allowed and exceptions arrays"
    );
  }
  for (const exception of parsed.exceptions) {
    if (
      !exception.name ||
      !exception.license ||
      !exception.owner ||
      !exception.expires
    ) {
      throw new Error(
        "Each license exception needs name, license, owner, and expires"
      );
    }
  }
  return parsed;
}

function normalizeExpression(expression: string): string {
  return expression
    .replace(/[()]/g, " ")
    .replace(/\//g, " OR ")
    .replace(/\s+/g, " ")
    .trim();
}

function isAllowed(
  name: string,
  expression: string,
  allowlist: LicenseAllowlist
): boolean {
  const normalized = normalizeExpression(expression);
  const allowed = new Set(allowlist.allowed);

  const matchesException = allowlist.exceptions.some(
    (exception) => exception.name === name && exception.license === expression
  );
  if (matchesException) {
    return true;
  }

  return normalized
    .split(/\s+OR\s+/i)
    .some((orPart) =>
      orPart.split(/\s+AND\s+/i).every((token) => allowed.has(token.trim()))
    );
}

function expiredExceptions(
  name: string,
  expression: string,
  allowlist: LicenseAllowlist
): LicenseException[] {
  const today = new Date().toISOString().slice(0, 10);
  return allowlist.exceptions.filter(
    (exception) =>
      exception.name === name &&
      exception.license === expression &&
      exception.expires < today
  );
}

function checkJavaScript(allowlist: LicenseAllowlist): number {
  const output = execFileSync(PNPM, ["licenses", "list", "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 50 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  const groups = JSON.parse(output) as Record<string, JavaScriptPackage[]>;
  const failures: string[] = [];
  let count = 0;

  for (const [expression, packages] of Object.entries(groups)) {
    for (const pkg of packages) {
      count += 1;
      if (isAllowed(pkg.name, expression, allowlist)) {
        const expired = expiredExceptions(pkg.name, expression, allowlist);
        if (expired.length > 0) {
          failures.push(
            `${pkg.name}: license exception for ${expression} expired on ${expired[0].expires}`
          );
        }
        continue;
      }
      failures.push(`${pkg.name}: license ${expression} is not allowed`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `JavaScript license check failed:\n${failures
        .map((failure) => `  ${failure}`)
        .join("\n")}`
    );
  }
  return count;
}

function checkRust(allowlist: LicenseAllowlist): number {
  const output = execFileSync(
    CARGO,
    ["metadata", "--format-version", "1", "--manifest-path", "Cargo.toml"],
    {
      cwd: CONTRACTS_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: 100 * 1024 * 1024,
    }
  );
  const metadata = JSON.parse(output) as CargoMetadata;
  const failures: string[] = [];
  let count = 0;

  for (const pkg of metadata.packages) {
    if (pkg.source === null) {
      continue;
    }
    count += 1;
    const expression =
      pkg.license ?? (pkg.license_file ? "LicenseRef" : "Unknown");
    if (isAllowed(pkg.name, expression, allowlist)) {
      const expired = expiredExceptions(pkg.name, expression, allowlist);
      if (expired.length > 0) {
        failures.push(
          `${pkg.name} ${pkg.version}: license exception for ${expression} expired on ${expired[0].expires}`
        );
      }
      continue;
    }
    failures.push(
      `${pkg.name} ${pkg.version}: license ${expression} is not allowed`
    );
  }

  if (failures.length > 0) {
    throw new Error(
      `Rust license check failed:\n${failures
        .map((failure) => `  ${failure}`)
        .join("\n")}`
    );
  }
  return count;
}

function main(): void {
  const allowlist = loadAllowlist();
  const jsOnly = process.argv.includes("--js-only");
  const jsCount = checkJavaScript(allowlist);
  console.log(`Checked ${jsCount} JavaScript packages.`);

  if (jsOnly) {
    console.log("Skipped Rust license check because --js-only was passed.");
    return;
  }

  const rustCount = checkRust(allowlist);
  console.log(`Checked ${rustCount} Rust packages.`);
  console.log("All dependency licenses are allowed.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
