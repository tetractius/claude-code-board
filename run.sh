#!/usr/bin/env bash
# Build-and-run in one shot. Installs dependencies on first use.
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
exec npm run dev
