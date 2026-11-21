import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const DOCS_PATH = resolve(REPO_ROOT, "apps/docs/architecture/api-errors.md");
const API_CORE_SRC = resolve(REPO_ROOT, "packages/api-core/src");

// Standard error codes expected across the API layer
const REQUIRED_ERROR_CODES = [
  "VALIDATION_ERROR",
  "INVALID_PUBLIC_KEY",
  "INVALID_PARAMETER",
  "MISSING_TRUSTLINE",
  "CONTRACT_SIMULATION_ERROR",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
  "SERVICE_UNAVAILABLE",
];

// Required HTTP statuses used across the API handlers
const REQUIRED_HTTP_STATUSES = [400, 401, 403, 404, 405, 429, 500, 503];

// Contract error codes explicitly mapped in packages/api-core/src/tx.ts
const REQUIRED_CONTRACT_ERROR_CODES = [3, 7, 15, 18];

function parseCatalogTable(markdown, sectionHeading) {
  const sections = markdown.split(/(?=^## )/m);
  const section = sections.find((s) => s.startsWith(`## ${sectionHeading}`));
  if (!section) {
    throw new Error(`Missing section starting with "## ${sectionHeading}" in api-errors.md`);
  }

  const rows = [];
  for (const line of section.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());

    // Skip separator lines (| --- | --- | ...)
    if (cells.length === 0 || cells.every((c) => /^[-: ]+$/.test(c))) continue;
    rows.push(cells);
  }

  return rows;
}

function main() {
  const docsContent = readFileSync(DOCS_PATH, "utf8");
  const failures = [];
  let totalChecked = 0;

  // 1. Verify HTTP Status Codes Table
  const statusRows = parseCatalogTable(docsContent, "HTTP Status Codes");
  const documentedStatuses = new Set();
  for (const row of statusRows.slice(1)) { // skip header
    const code = Number.parseInt(row[0].replace(/`/g, ""), 10);
    if (!Number.isNaN(code)) {
      documentedStatuses.add(code);
      if (!row[3]) {
        failures.push(`HTTP status ${code} is missing retry guidance`);
      }
      if (!row[4]) {
        failures.push(`HTTP status ${code} is missing description`);
      }
    }
  }

  for (const status of REQUIRED_HTTP_STATUSES) {
    totalChecked += 1;
    if (!documentedStatuses.has(status)) {
      failures.push(`Missing HTTP status code ${status} in api-errors.md`);
    }
  }

  // 2. Verify API Error Codes Catalog Table
  const errorRows = parseCatalogTable(docsContent, "API Error Code Catalog");
  const documentedErrors = new Map();
  for (const row of errorRows.slice(1)) { // skip header
    const code = row[0].replace(/`/g, "");
    documentedErrors.set(code, {
      status: row[1],
      condition: row[2],
      retryable: row[3],
      action: row[4],
    });
  }

  for (const code of REQUIRED_ERROR_CODES) {
    totalChecked += 1;
    const entry = documentedErrors.get(code);
    if (!entry) {
      failures.push(`Missing error code ${code} in API Error Code Catalog`);
      continue;
    }
    if (!entry.condition) {
      failures.push(`Missing condition/cause for error code ${code}`);
    }
    if (!entry.retryable) {
      failures.push(`Missing retry guidance for error code ${code}`);
    }
    if (!entry.action) {
      failures.push(`Missing recommended action for error code ${code}`);
    }
  }

  // 3. Verify Contract Simulation Error Codes (from tx.ts)
  const contractErrorRows = parseCatalogTable(
    docsContent,
    "Contract Simulation Errors"
  );
  const documentedContractCodes = new Set();
  for (const row of contractErrorRows.slice(1)) { // skip header
    const match = row[0].match(/`(\d+)`/);
    if (match) {
      const num = Number.parseInt(match[1], 10);
      documentedContractCodes.add(num);
    }
  }

  for (const num of REQUIRED_CONTRACT_ERROR_CODES) {
    totalChecked += 1;
    if (!documentedContractCodes.has(num)) {
      failures.push(
        `Missing contract simulation error code ${num} in Contract Simulation Errors table`
      );
    }
  }

  // 4. Verify that packages/api-core/src/ files are present and match
  const files = readdirSync(API_CORE_SRC);
  if (!files.includes("tx.ts") || !files.includes("vaults.ts")) {
    failures.push(`packages/api-core/src directory missing expected handler files`);
  }

  if (failures.length > 0) {
    console.error("API error catalog check failed:\n");
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }

  console.log(
    `API error catalog check passed (${totalChecked} error checks verified successfully).`
  );
}

main();
