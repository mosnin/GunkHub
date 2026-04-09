#!/usr/bin/env bash
# validate.sh — Run typecheck, build, and lint across all packages and report pass/fail.
#
# Usage:
#   ./scripts/validate.sh           # run all checks
#   ./scripts/validate.sh typecheck # run only typecheck
#   ./scripts/validate.sh build     # run only build
#   ./scripts/validate.sh lint      # run only lint

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ANSI color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

declare -A RESULTS
FAILED=0

# ─── Helpers ──────────────────────────────────────────────────────────────────

log_header() {
  echo ""
  echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${BOLD}${CYAN}  $1${RESET}"
  echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
}

run_check() {
  local name="$1"
  local cmd="$2"

  echo ""
  echo -e "${YELLOW}▶ Running ${BOLD}${name}${RESET}${YELLOW}...${RESET}"

  local start_time
  start_time=$(date +%s)

  if eval "$cmd" 2>&1; then
    local end_time
    end_time=$(date +%s)
    local elapsed=$((end_time - start_time))
    RESULTS["$name"]="PASS"
    echo -e "${GREEN}✓ ${name} passed${RESET} ${CYAN}(${elapsed}s)${RESET}"
  else
    local end_time
    end_time=$(date +%s)
    local elapsed=$((end_time - start_time))
    RESULTS["$name"]="FAIL"
    FAILED=1
    echo -e "${RED}✗ ${name} failed${RESET} ${CYAN}(${elapsed}s)${RESET}"
  fi
}

print_summary() {
  echo ""
  log_header "Validation Summary"
  echo ""

  for check in typecheck build lint; do
    if [[ -v RESULTS[$check] ]]; then
      local result="${RESULTS[$check]}"
      if [[ "$result" == "PASS" ]]; then
        echo -e "  ${GREEN}✓ PASS${RESET}  ${check}"
      else
        echo -e "  ${RED}✗ FAIL${RESET}  ${check}"
      fi
    else
      echo -e "  ${YELLOW}–      ${RESET}  ${check} (skipped)"
    fi
  done

  echo ""

  if [[ $FAILED -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}All checks passed.${RESET}"
  else
    echo -e "${RED}${BOLD}One or more checks failed. Fix the errors above and re-run.${RESET}"
  fi

  echo ""
}

# ─── Pre-flight ───────────────────────────────────────────────────────────────

log_header "Agent Flight Recorder — Validate"

# Ensure pnpm is available
if ! command -v pnpm &>/dev/null; then
  echo -e "${RED}Error: pnpm not found. Install it with: npm install -g pnpm@9${RESET}"
  exit 1
fi

# Ensure node_modules exist
if [[ ! -d "node_modules" ]]; then
  echo -e "${YELLOW}node_modules not found — running pnpm install...${RESET}"
  pnpm install --frozen-lockfile
fi

# ─── Determine which checks to run ───────────────────────────────────────────

CHECKS_TO_RUN=("typecheck" "build" "lint")

if [[ $# -gt 0 ]]; then
  CHECKS_TO_RUN=("$@")
fi

# ─── Run checks ───────────────────────────────────────────────────────────────

for check in "${CHECKS_TO_RUN[@]}"; do
  case "$check" in
    typecheck)
      run_check "typecheck" "pnpm typecheck"
      ;;
    build)
      run_check "build" "pnpm build"
      ;;
    lint)
      run_check "lint" "pnpm lint"
      ;;
    *)
      echo -e "${RED}Unknown check: ${check}. Valid options: typecheck, build, lint${RESET}"
      exit 1
      ;;
  esac
done

# ─── Summary ──────────────────────────────────────────────────────────────────

print_summary

if [[ $FAILED -ne 0 ]]; then
  exit 1
fi
