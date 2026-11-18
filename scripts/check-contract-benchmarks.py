#!/usr/bin/env python3
"""Compare Soroban test cost estimates with the checked-in resource baselines."""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path


METRICS = ("cpu_instructions", "memory_bytes", "fee_stroops")
RECORD = re.compile(r"SOROBAN_BENCHMARK\|([^|]+)\|(\d+)\|(\d+)\|(\d+)")


def compiler_version():
    return subprocess.run(
        ["rustc", "--version"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def locked_sdk_version():
    lockfile = Path(__file__).resolve().parents[1] / "packages" / "contracts" / "Cargo.lock"
    lock_text = lockfile.read_text(encoding="utf-8")
    match = re.search(
        r'(?m)^\[\[package\]\]\nname = "soroban-sdk"\nversion = "([^"]+)"',
        lock_text,
    )
    if not match:
        raise ValueError(f"could not find soroban-sdk version in {lockfile}")
    return match.group(1)


def read_results(path):
    results = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = RECORD.search(line)
        if match:
            name, cpu, memory, fee = match.groups()
            if name in results:
                raise ValueError(f"duplicate benchmark result: {name}")
            results[name] = {
                "cpu_instructions": int(cpu),
                "memory_bytes": int(memory),
                "fee_stroops": int(fee),
            }
    if not results:
        raise ValueError(f"no benchmark records found in {path}")
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="cargo test output log")
    parser.add_argument("--baseline", type=Path, required=True, help="baseline JSON path")
    parser.add_argument("--output", type=Path, required=True, help="results JSON path")
    parser.add_argument(
        "--update",
        action="store_true",
        help="replace baseline resource values with the current measurements",
    )
    args = parser.parse_args()

    baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
    measured = read_results(args.input)
    sdk_version = locked_sdk_version()
    if not args.update and sdk_version != baseline["soroban_sdk_version"]:
        raise ValueError(
            f"Soroban SDK lockfile version {sdk_version} differs from baseline "
            f"{baseline['soroban_sdk_version']}; review and refresh the baseline"
        )
    expected_names = set(baseline["benchmarks"])
    measured_names = set(measured)
    missing = sorted(expected_names - measured_names)
    unexpected = sorted(measured_names - expected_names)
    if missing or unexpected:
        raise ValueError(
            f"benchmark set mismatch; missing={missing}, unexpected={unexpected}"
        )

    rustc = compiler_version()
    tolerance = baseline["tolerance_percent"]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(
            {
                "rustc_version": rustc,
                "soroban_sdk_version": sdk_version,
                "tolerance_percent": tolerance,
                "benchmarks": measured,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )

    if args.update:
        baseline["rustc_version"] = rustc
        baseline["soroban_sdk_version"] = sdk_version
        baseline["baseline_policy"] = (
            "Measured native Soroban cost estimates; tolerance is applied separately."
        )
        baseline["benchmarks"] = measured
        args.baseline.write_text(
            json.dumps(baseline, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print(f"Updated {args.baseline} with {len(measured)} benchmark results.")
        return 0

    failures = []
    for name in sorted(expected_names):
        for metric in METRICS:
            limit = baseline["benchmarks"][name][metric]
            actual = measured[name][metric]
            allowed = (limit * (100 + tolerance) + 99) // 100
            if actual > allowed:
                failures.append(
                    f"{name} {metric}: {actual} exceeds {allowed} "
                    f"(baseline {limit}, tolerance {tolerance}%)"
                )

    if failures:
        print("Soroban benchmark regression(s):", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        print(
            f"Current results were written to {args.output}.",
            file=sys.stderr,
        )
        return 1

    print(
        f"All {len(measured)} Soroban benchmarks are within "
        f"{tolerance}% of baseline."
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"Benchmark check failed: {error}", file=sys.stderr)
        raise SystemExit(2)
