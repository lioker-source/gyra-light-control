#!/usr/bin/env bash
set -euo pipefail

# Run this ON atriumlight to capture the real production DB including
# patch, presets, stored ML positions and settings.
# Password is requested interactively.

OUT="${1:-atrium-light-production-data.sql}"
mysqldump \
  --single-transaction \
  --routines \
  --triggers \
  --default-character-set=utf8mb4 \
  -u gyra -p lichtsteuerung > "$OUT"

echo "Database dump written to: $OUT"
