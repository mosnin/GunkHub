#!/usr/bin/env bash
# validate-build.sh — Runs typecheck and build for all workspace packages.
# Exits with code 1 if any step fails.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PASS=0
FAIL=0
ERRORS=()

run_step() {
  local label="$1"
  shift
  echo ""
  echo "▶ $label"
  if "$@"; then
    echo "  ✓ $label passed"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label FAILED"
    FAIL=$((FAIL + 1))
    ERRORS+=("$label")
  fi
}

echo "============================================="
echo "  Agent Flight Recorder — Build Validation"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================="

# ── contracts package ─────────────────────────────────────────────────────────
if [ -d "$REPO_ROOT/packages/contracts" ]; then
  run_step "contracts: typecheck" \
    bash -c "cd '$REPO_ROOT/packages/contracts' && pnpm typecheck"

  run_step "contracts: build" \
    bash -c "cd '$REPO_ROOT/packages/contracts' && pnpm build"
else
  echo "  ⚠  packages/contracts not found — skipping"
fi

# ── sdk package ───────────────────────────────────────────────────────────────
if [ -d "$REPO_ROOT/packages/sdk" ]; then
  run_step "sdk: typecheck" \
    bash -c "cd '$REPO_ROOT/packages/sdk' && pnpm typecheck"

  run_step "sdk: build" \
    bash -c "cd '$REPO_ROOT/packages/sdk' && pnpm build"
else
  echo "  ⚠  packages/sdk not found — skipping"
fi

# ── web app ───────────────────────────────────────────────────────────────────
if [ -d "$REPO_ROOT/apps/web" ]; then
  run_step "web: typecheck" \
    bash -c "cd '$REPO_ROOT/apps/web' && pnpm typecheck"

  run_step "web: build" \
    bash -c "cd '$REPO_ROOT/apps/web' && pnpm build"
else
  echo "  ⚠  apps/web not found — skipping"
fi

# ── turbo global checks ───────────────────────────────────────────────────────
run_step "turbo: lint (all packages)" \
  bash -c "cd '$REPO_ROOT' && pnpm turbo lint"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "============================================="
echo "  Validation Summary"
echo "============================================="
echo "  Passed : $PASS"
echo "  Failed : $FAIL"

if [ "${#ERRORS[@]}" -gt 0 ]; then
  echo ""
  echo "  Failing steps:"
  for err in "${ERRORS[@]}"; do
    echo "    - $err"
  done
fi

echo "============================================="

if [ "$FAIL" -gt 0 ]; then
  echo "  RESULT: FAILED — fix errors above before committing."
  exit 1
else
  echo "  RESULT: ALL CHECKS PASSED"
  exit 0
fi
