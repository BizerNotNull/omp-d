#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
exec bun scripts/benchmark-ui.mjs
