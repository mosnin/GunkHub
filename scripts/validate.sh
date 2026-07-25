#!/usr/bin/env bash
# validate.sh — Run typecheck, build, and lint across all packages and report pass/fail.
#
# Usage:
#   ./scripts/validate.sh           # run all checks
#   ./scripts/validate.sh typecheck # run only typecheck
#   ./scripts/validate.sh build     # run only build
#   ./scripts/validate.sh build-integrity # run only the stale/partial artifact check
#   ./scripts/validate.sh lint      # run only lint
#   ./scripts/validate.sh convex-refs # run only the convex ref/call-site check
#   ./scripts/validate.sh design-tokens # run only the design.md conformance check

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

  for check in typecheck build build-integrity lint schema-drift convex-refs design-tokens; do
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

CHECKS_TO_RUN=("typecheck" "build" "build-integrity" "lint" "schema-drift" "convex-refs" "design-tokens")

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
    build-integrity)
      # MUST run after `build`. Detects dist/ artifacts left behind by a build
      # that RAN AND PARTIALLY FAILED — the case a cold `rm -rf packages/*/dist`
      # cannot reach, because the stale file was written by a real build, not
      # left by a missing one. Specifically: a `tsup` run whose DTS step fails
      # leaves the PREVIOUS index.d.ts on disk (contracts and sdk build without
      # --clean), and every `tsc` in the repo then typechecks against types that
      # no longer describe the source, at exit 0. See the script header.
      run_check "build-integrity" "pnpm tsx scripts/check-build-integrity.ts"
      ;;
    lint)
      run_check "lint" "pnpm lint"
      ;;
    schema-drift)
      run_check "schema-drift" "pnpm tsx scripts/check-schema-drift.ts"
      ;;
    convex-refs)
      # Cross-checks the hand-maintained makeFunctionReference string refs in
      # apps/web/src/lib/convexFunctions.ts against the real convex/*.ts
      # registrations. TypeScript cannot see this seam; see the script header.
      run_check "convex-refs" "pnpm tsx scripts/check-convex-refs.ts"
      ;;
    design-tokens)
      # Enforces design.md ("Neon"), which CLAUDE.md declares authoritative for
      # the visual system. Nothing else in the repo does: not eslint, not the
      # type system, not the build. The script parses design.md's own token
      # tables and WCAG matrix at run time and resolves every Tailwind class
      # back to a token by VALUE, so `text-neutral-500` is caught as the Ash it
      # actually is. See the script header.
      run_check "design-tokens" "pnpm tsx scripts/check-design-tokens.ts"
      ;;
    *)
      echo -e "${RED}Unknown check: ${check}. Valid options: typecheck, build, build-integrity, lint, schema-drift, convex-refs, design-tokens${RESET}"
      exit 1
      ;;
  esac
done

# ─── Summary ──────────────────────────────────────────────────────────────────

print_summary

if [[ $FAILED -ne 0 ]]; then
  exit 1
fi
