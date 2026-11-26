// Checks that apps/docs/architecture/api-errors.md documents every error code
// and contract rejection the API can actually return. The codes are read from
// the source, so adding a code to a handler without documenting it fails here.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const DOCS_PATH = resolve(REPO_ROOT, "apps/docs/architecture/api-errors.md");
const ENVELOPE_PATH = resolve(
  REPO_ROOT,
  "packages/api-core/src/error-envelope.ts"
);
const TX_PATH = resolve(REPO_ROOT, "packages/api-core/src/tx.ts");
const SOURCE_DIRS = ["api", "packages/api-core/src", "apps/api-local/src"];

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__") {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (/\.ts$/.test(entry) && !/\.(test|d)\.ts$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

// Default code per HTTP status, from `defaultErrorCode` in error-envelope.ts.
function defaultCodes() {
  const source = readFileSync(ENVELOPE_PATH, "utf8");
  const body = source.match(
    /function defaultErrorCode\(status: number\): string \{([\s\S]*?)\n\}/
  );
  if (!body) throw new Error("defaultErrorCode not found in error-envelope.ts");
  const codes = new Map();
  for (const match of body[1].matchAll(
    /status === (\d{3})\) return "([A-Z_]+)"/g
  )) {
    codes.set(Number(match[1]), match[2]);
  }
  for (const match of body[1].matchAll(
    /return [^"\n]*"([A-Z_]+)" : "([A-Z_]+)"/g
  )) {
    codes.set("5xx", match[1]);
    codes.set("other4xx", match[2]);
  }
  return codes;
}

// Codes a handler sets explicitly with `code: "X"`.
function explicitCodes() {
  const codes = new Set();
  for (const dir of SOURCE_DIRS) {
    for (const file of sourceFiles(resolve(REPO_ROOT, dir))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\bcode: "([A-Z][A-Z_]+)"/g)) {
        codes.add(match[1]);
      }
    }
  }
  codes.delete("custom");
  return codes;
}

// Contract errors mapped to a readable message in tx.ts.
function userFixableContractCodes() {
  const source = readFileSync(TX_PATH, "utf8");
  const block = source.match(
    /USER_FIXABLE_CONTRACT_ERRORS[^{]*\{([\s\S]*?)\n\};/
  );
  if (!block)
    throw new Error("USER_FIXABLE_CONTRACT_ERRORS not found in tx.ts");
  return [...block[1].matchAll(/^\s*(\d+):/gm)].map((m) => Number(m[1]));
}

function tableRows(markdown, heading) {
  const section = markdown
    .split(/(?=^## )/m)
    .find((s) => s.startsWith(`## ${heading}`));
  if (!section) throw new Error(`Missing "## ${heading}" section`);
  return section
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim())
    )
    .filter((cells) => !cells.every((cell) => /^[-: ]+$/.test(cell)))
    .slice(1);
}

function main() {
  const docs = readFileSync(DOCS_PATH, "utf8");
  const failures = [];
  let checked = 0;

  const catalog = new Map();
  for (const row of tableRows(docs, "API Error Code Catalog")) {
    catalog.set(row[0].replace(/`/g, ""), row);
  }
  const statusTable = new Set(
    tableRows(docs, "HTTP Status Codes").map((row) => row[0].replace(/`/g, ""))
  );

  const defaults = defaultCodes();
  const required = new Set(explicitCodes());
  for (const code of defaults.values()) required.add(code);

  for (const code of [...required].sort()) {
    checked += 1;
    const row = catalog.get(code);
    if (!row) {
      failures.push(`Missing error code ${code} in the API Error Code Catalog`);
      continue;
    }
    if (!row[2]) failures.push(`Missing condition for error code ${code}`);
    if (!row[3]) failures.push(`Missing retry guidance for error code ${code}`);
    if (!row[4]) failures.push(`Missing client action for error code ${code}`);
  }
  for (const code of catalog.keys()) {
    if (!required.has(code)) {
      failures.push(`${code} is documented but no handler or default uses it`);
    }
  }

  for (const status of [...defaults.keys()].filter(
    (k) => typeof k === "number"
  )) {
    checked += 1;
    if (!statusTable.has(String(status))) {
      failures.push(
        `Missing HTTP status ${status} in the HTTP Status Codes table`
      );
    }
  }

  const contractRows = tableRows(docs, "Contract Simulation Errors");
  const documentedContract = new Set(
    contractRows
      .map((row) => row[0].match(/`(\d+)`/))
      .filter(Boolean)
      .map((match) => Number(match[1]))
  );
  for (const code of userFixableContractCodes()) {
    checked += 1;
    if (!documentedContract.has(code)) {
      failures.push(
        `Missing contract error ${code} in Contract Simulation Errors`
      );
    }
  }

  if (failures.length > 0) {
    console.error("API error catalog check failed:\n");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`API error catalog check passed (${checked} checks).`);
}

main();
