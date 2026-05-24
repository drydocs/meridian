#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/dist"

echo "▶ Cleaning output directory…"
rm -rf "$OUT"
mkdir -p "$OUT"

echo "▶ Building React app (base: /app/)…"
pnpm --filter @meridian/web build

echo "▶ Assembling combined output…"
# Landing page → dist/index.html
cp "$ROOT/apps/landing/index.html" "$OUT/index.html"

# React SPA build → dist/app/
cp -r "$ROOT/apps/web/dist/." "$OUT/app/"

echo "✓ dist/ structure:"
find "$OUT" -maxdepth 2 | sort

echo ""
echo "  Landing : $OUT/index.html ($(wc -c < "$OUT/index.html") bytes)"
echo "  App     : $OUT/app/index.html ($(wc -c < "$OUT/app/index.html") bytes)"
