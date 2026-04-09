#!/usr/bin/env tsx
/**
 * Validates that all packages can typecheck and build.
 * Run: pnpm tsx scripts/validate.ts
 */
import { execSync } from 'child_process'

interface Check {
  name: string
  command: string
}

const checks: Check[] = [
  { name: 'contracts typecheck', command: 'pnpm --filter @agent-flight-recorder/contracts typecheck' },
  { name: 'sdk typecheck', command: 'pnpm --filter @agent-flight-recorder/sdk typecheck' },
  { name: 'web typecheck', command: 'pnpm --filter @agent-flight-recorder/web typecheck' },
  { name: 'contracts build', command: 'pnpm --filter @agent-flight-recorder/contracts build' },
  { name: 'sdk build', command: 'pnpm --filter @agent-flight-recorder/sdk build' },
]

const results: Array<{ name: string; passed: boolean; error?: string }> = []

for (const check of checks) {
  try {
    execSync(check.command, { stdio: 'pipe' })
    results.push({ name: check.name, passed: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    results.push({ name: check.name, passed: false, error: message.slice(0, 200) })
  }
}

console.log('\n=== Validation Results ===\n')
for (const r of results) {
  const icon = r.passed ? '✓' : '✗'
  const label = r.passed ? 'PASS' : 'FAIL'
  console.log(`${icon} ${label}  ${r.name}`)
  if (r.error) console.log(`       ${r.error}\n`)
}

const failures = results.filter(r => !r.passed)
console.log(`\n${results.length - failures.length}/${results.length} checks passed`)
if (failures.length > 0) process.exit(1)
