#!/usr/bin/env tsx
import {
  runKeeperDoctor,
  type KeeperDoctorReport,
  type KeeperDoctorTarget,
} from "../packages/stellar-sdk-helpers/src/keeper-doctor";

interface CliArgs {
  keeper: KeeperDoctorTarget;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let keeper: KeeperDoctorTarget = "migration";
  let json = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--keeper") {
      const value = argv[i + 1];
      if (value !== "migration" && value !== "accrual") {
        throw new Error(
          `Invalid --keeper value "${value ?? ""}"; expected "migration" or "accrual"`
        );
      }
      keeper = value;
      i += 1;
    } else if (arg.startsWith("--keeper=")) {
      const value = arg.slice("--keeper=".length);
      if (value !== "migration" && value !== "accrual") {
        throw new Error(
          `Invalid --keeper value "${value}"; expected "migration" or "accrual"`
        );
      }
      keeper = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { keeper, json, help };
}

function formatReport(report: KeeperDoctorReport): string {
  const lines: string[] = [
    `Meridian Keeper Doctor (${report.keeper} @ ${report.network})`,
    `Status: ${report.status.toUpperCase()}`,
  ];
  if (report.signerPublicKey) {
    lines.push(`Signer: ${report.signerPublicKey}`);
  }
  lines.push("");

  for (const check of report.checks) {
    const badge =
      check.status === "pass"
        ? "PASS"
        : check.status === "blocked"
          ? "BLOCKED"
          : "FAIL";
    lines.push(`[${badge}] ${check.id}: ${check.summary}`);
    if (check.remediation) {
      lines.push(`       Remediation: ${check.remediation}`);
    }
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: pnpm keeper:doctor [--keeper migration|accrual] [--json]"
    );
    return;
  }

  const report = await runKeeperDoctor({
    keeper: args.keeper,
    env: process.env,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(
    "[keeper-doctor] failed:",
    err instanceof Error ? err.message : String(err)
  );
  process.exitCode = 1;
});
