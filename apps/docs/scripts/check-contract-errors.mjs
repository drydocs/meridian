import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const DOCS_PATH = resolve(
  REPO_ROOT,
  "apps/docs/architecture/contract-errors.md"
);

const CONTRACTS = [
  {
    name: "vault",
    sectionPrefix: "## Vault",
    rustFile: "packages/contracts/vault/src/errors.rs",
  },
  {
    name: "blend-adapter",
    sectionPrefix: "## Blend Adapter",
    rustFile: "packages/contracts/blend-adapter/src/errors.rs",
  },
  {
    name: "defindex-adapter",
    sectionPrefix: "## DeFindex Adapter",
    rustFile: "packages/contracts/defindex-adapter/src/lib.rs",
  },
  {
    name: "musdc-token",
    sectionPrefix: "## mUSDC Token",
    rustFile: "packages/contracts/musdc-token/src/lib.rs",
  },
];

function parseRustContractErrors(source, filePath) {
  const enumMatch = source.match(/pub\s+enum\s+ContractError\s*\{([\s\S]*?)\}/);
  if (!enumMatch) {
    throw new Error(`Could not find \`pub enum ContractError\` in ${filePath}`);
  }

  const body = enumMatch[1];
  const variants = [];

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line) continue;

    const variantMatch = line.match(/^([A-Z][A-Za-z0-9_]*)\s*=\s*(\d+)\s*,?$/);
    if (variantMatch) {
      variants.push({
        name: variantMatch[1],
        code: Number.parseInt(variantMatch[2], 10),
      });
    }
  }

  if (variants.length === 0) {
    throw new Error(`No ContractError variants parsed from ${filePath}`);
  }

  return variants;
}

function parseDocumentedSection(markdown, sectionPrefix) {
  const sections = markdown.split(/(?=^## )/m);
  const section = sections.find((s) => s.startsWith(sectionPrefix));
  if (!section) {
    throw new Error(
      `Missing section starting with "${sectionPrefix}" in contract-errors.md`
    );
  }

  const documented = new Map();
  for (const line of section.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());

    if (cells.length < 4) continue;
    const variantMatch = cells[0].match(/^`([A-Z][A-Za-z0-9_]*)`$/);
    if (!variantMatch) continue;

    const code = Number.parseInt(cells[1], 10);
    if (Number.isNaN(code)) continue;

    documented.set(variantMatch[1], {
      name: variantMatch[1],
      code,
      cause: cells[2],
      response: cells[3],
    });
  }

  return documented;
}

function main() {
  const docsContent = readFileSync(DOCS_PATH, "utf8");
  const failures = [];
  let totalChecked = 0;

  for (const contract of CONTRACTS) {
    const rustPath = resolve(REPO_ROOT, contract.rustFile);
    const rustContent = readFileSync(rustPath, "utf8");
    const rustVariants = parseRustContractErrors(
      rustContent,
      contract.rustFile
    );
    const docVariants = parseDocumentedSection(
      docsContent,
      contract.sectionPrefix
    );

    for (const variant of rustVariants) {
      totalChecked += 1;
      const doc = docVariants.get(variant.name);
      if (!doc) {
        failures.push(
          `[${contract.name}] Missing documentation for ContractError::${variant.name} (= ${variant.code})`
        );
        continue;
      }
      if (doc.code !== variant.code) {
        failures.push(
          `[${contract.name}] Code mismatch for ContractError::${variant.name}: Rust has ${variant.code}, docs have ${doc.code}`
        );
      }
      if (!doc.cause) {
        failures.push(
          `[${contract.name}] Missing cause for ContractError::${variant.name}`
        );
      }
      if (!doc.response) {
        failures.push(
          `[${contract.name}] Missing response for ContractError::${variant.name}`
        );
      }
    }

    const rustNames = new Set(rustVariants.map((v) => v.name));
    for (const docName of docVariants.keys()) {
      if (!rustNames.has(docName)) {
        failures.push(
          `[${contract.name}] Documented variant ContractError::${docName} does not exist in ${contract.rustFile}`
        );
      }
    }
  }

  if (failures.length > 0) {
    console.error("Contract error reference check failed:\n");
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }

  console.log(
    `Contract error reference check passed (${totalChecked} variants across ${CONTRACTS.length} contracts).`
  );
}

main();
