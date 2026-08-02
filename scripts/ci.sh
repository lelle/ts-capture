#!/usr/bin/env bash
# Run the same checks GitHub Actions runs (.github/workflows/ci.yml), in the
# same order. Exits on first failure so the failing step is the last thing
# printed.
#
# Usage (preferred):
#   pnpm verify              # full pipeline (install + check + build + test)
#   pnpm verify --skip-install  # skip pnpm install (fast iteration when deps unchanged)
#   pnpm verify --skip-test     # skip Vitest run (fastest pre-push check)
#
# (`pnpm ci` is NOT this script — pnpm 11+ reserves `pnpm ci` as a built-in
# alias for `pnpm install --frozen-lockfile`, so the script is exposed as
# `pnpm verify` instead. Or call directly: `scripts/ci.sh ...`)
#
# Mirrored steps:
#   1. Install dependencies      (pnpm install --frozen-lockfile)
#   2. Format check              (pnpm format:check)
#   3. Lint                      (pnpm lint, --deny-warnings)
#   4. Typed lint                (pnpm lint:types — type-aware correctness)
#   5. Dead-code (knip)          (pnpm lint:knip)
#   6. Build                     (pnpm build)
#   7. Typecheck (incl. specs)   (pnpm typecheck)
#   8. Test + coverage           (pnpm -r test:coverage)

set -eEuo pipefail  # -E makes the ERR trap fire from inside run_step

MONOREPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$MONOREPO_ROOT"

SKIP_INSTALL=false
SKIP_TEST=false
for arg in "$@"; do
  case "$arg" in
    --skip-install) SKIP_INSTALL=true ;;
    --skip-test)    SKIP_TEST=true ;;
    -h|--help)
      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg" >&2
      exit 2
      ;;
  esac
done

# Color helpers — disabled when stdout isn't a TTY (e.g. piped to a file).
if [ -t 1 ]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; RED=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  BOLD=""; GREEN=""; RED=""; DIM=""; RESET=""
fi

CURRENT_STEP=""
on_failure() {
  local exit_code=$?
  if [ -n "$CURRENT_STEP" ]; then
    echo
    echo "${RED}${BOLD}✗ FAILED:${RESET} ${BOLD}${CURRENT_STEP}${RESET} (exit ${exit_code})"
  fi
  exit "$exit_code"
}
trap on_failure ERR

run_step() {
  CURRENT_STEP="$1"
  shift
  echo
  echo "${BOLD}── ${CURRENT_STEP}${RESET} ${DIM}\$ $*${RESET}"
  local start end
  start=$(date +%s)
  "$@"
  end=$(date +%s)
  echo "${GREEN}✓${RESET} ${CURRENT_STEP} ${DIM}(${BOLD}$((end - start))s${RESET}${DIM})${RESET}"
}

OVERALL_START=$(date +%s)

if [ "$SKIP_INSTALL" = false ]; then
  run_step "Install dependencies" pnpm install --frozen-lockfile
else
  echo "${DIM}── Install dependencies — skipped (--skip-install)${RESET}"
fi

run_step "Format check"           pnpm format:check
run_step "Lint"                   pnpm lint
run_step "Typed lint"             pnpm lint:types
run_step "Dead-code (knip)"       pnpm lint:knip
run_step "Build"                  pnpm build
run_step "Typecheck (incl. specs)" pnpm typecheck

if [ "$SKIP_TEST" = false ]; then
  run_step "Test + coverage"      pnpm -r test:coverage
else
  echo "${DIM}── Test + coverage — skipped (--skip-test)${RESET}"
fi

CURRENT_STEP=""
OVERALL_END=$(date +%s)
echo
echo "${GREEN}${BOLD}✓ All CI checks passed${RESET} ${DIM}($((OVERALL_END - OVERALL_START))s total)${RESET}"
