#!/usr/bin/env tsx
/**
 * license-gate.ts
 *
 * Enforces the license allowlist for production dependencies across the
 * pnpm workspace and reports (without failing) on devDependency licenses.
 *
 * Data source: `pnpm licenses list --json[/--prod/-D]`. This walks the
 * pnpm workspace's resolved dependency graph directly, so it stays correct
 * across all workspace packages without needing a lockfile format that
 * `pnpm licenses` doesn't already understand.
 *
 * Exit code: 0 if every production-dependency license is on the allowlist
 * (or covered by a named per-package exception), 1 otherwise. DevDependency
 * license violations are printed as warnings and never fail the run.
 *
 * Run: pnpm tsx scripts/license-gate.ts
 */

import { execFileSync } from 'node:child_process'

// -----------------------------------------------------------------------------
// Allowlist — SPDX identifiers considered acceptable for production
// dependencies without further review. Keep this in sync with the comment
// in .github/workflows/supply-chain.yml (the workflow re-states the list so
// a reviewer can see the gate's policy without opening this file).
// -----------------------------------------------------------------------------
const ALLOWED_LICENSES = new Set([
  'MIT',
  'Apache-2.0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'Python-2.0',
  'BlueOak-1.0.0',
])

// -----------------------------------------------------------------------------
// Named per-package exceptions — a disallowed license that is nonetheless
// acceptable for a SPECIFIC package, with the reason documented inline.
// Mirrors the existing `pnpm.auditConfig.ignoreGhsas` pattern in
// package.json: narrow, named, and reviewable rather than widening the
// allowlist for an entire license class.
// -----------------------------------------------------------------------------
const PACKAGE_EXCEPTIONS: Record<string, { license: string; reason: string }> = {
  'caniuse-lite': {
    license: 'CC-BY-4.0',
    reason:
      'Browser-support DATA (not code) consumed by browserslist/postcss/autoprefixer ' +
      'through the Next.js build pipeline. CC-BY-4.0 requires attribution for the ' +
      'compiled dataset, which caniuse-lite already provides in its own README; no ' +
      'redistributed source code carries this license. Ubiquitous transitive ' +
      'dependency of virtually every modern frontend toolchain.',
  },
}

interface LicenseGroup {
  name: string
  versions: string[]
}

type LicensesByKey = Record<string, LicenseGroup[]>

function runLicensesList(extraArgs: string[]): LicensesByKey {
  const out = execFileSync('pnpm', ['licenses', 'list', '--json', ...extraArgs], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  })
  return JSON.parse(out) as LicensesByKey
}

/**
 * Split an SPDX-ish license expression into its constituent identifiers and
 * the logical operator joining them. `pnpm licenses list` reports compound
 * expressions like "(MIT OR CC0-1.0)" verbatim as a single key.
 *
 * - "A OR B": satisfied if AT LEAST ONE identifier is allowed (dual license —
 *   consumers may pick either).
 * - "A AND B" (or a bare single identifier): satisfied only if EVERY
 *   identifier is allowed.
 */
function isLicenseKeyAllowed(licenseKey: string, isAllowed: (id: string) => boolean): boolean {
  const trimmed = licenseKey.replace(/^\(/, '').replace(/\)$/, '').trim()
  if (trimmed.includes(' OR ')) {
    return trimmed.split(' OR ').some((id) => isAllowed(id.trim()))
  }
  if (trimmed.includes(' AND ')) {
    return trimmed.split(' AND ').every((id) => isAllowed(id.trim()))
  }
  return isAllowed(trimmed)
}

function isAllowed(id: string): boolean {
  return ALLOWED_LICENSES.has(id)
}

/**
 * Evaluate one `pnpm licenses list` result. Returns the set of violations:
 * packages whose license key is not allowed and has no matching exception.
 */
function findViolations(licenses: LicensesByKey): Array<{ license: string; packages: string[] }> {
  const violations: Array<{ license: string; packages: string[] }> = []

  for (const [licenseKey, groups] of Object.entries(licenses)) {
    if (isLicenseKeyAllowed(licenseKey, isAllowed)) continue

    // Not directly allowed — check per-package exceptions before flagging.
    const unexcepted = groups.filter((g) => {
      const exception = PACKAGE_EXCEPTIONS[g.name]
      return !(exception && exception.license === licenseKey)
    })

    if (unexcepted.length > 0) {
      violations.push({
        license: licenseKey,
        packages: unexcepted.map((g) => `${g.name}@${g.versions.join(',')}`),
      })
    }
  }

  return violations
}

function main(): void {
  const lines: string[] = []
  lines.push('')
  lines.push('Agent Flight Recorder — License Gate')
  lines.push('─'.repeat(50))
  lines.push(`Allowlist: ${[...ALLOWED_LICENSES].join(', ')}`)
  if (Object.keys(PACKAGE_EXCEPTIONS).length > 0) {
    lines.push('Per-package exceptions:')
    for (const [name, { license, reason }] of Object.entries(PACKAGE_EXCEPTIONS)) {
      lines.push(`  - ${name} (${license}): ${reason}`)
    }
  }
  lines.push('')

  const prodLicenses = runLicensesList(['--prod'])
  const devLicenses = runLicensesList(['-D'])

  const prodViolations = findViolations(prodLicenses)
  const devViolations = findViolations(devLicenses)

  if (prodViolations.length === 0) {
    lines.push('  PASS  All production dependency licenses are allowed.')
  } else {
    lines.push('  FAIL  Production dependencies with disallowed licenses:')
    for (const v of prodViolations) {
      lines.push(`          ${v.license}:`)
      for (const pkg of v.packages) lines.push(`            - ${pkg}`)
    }
  }

  lines.push('')

  if (devViolations.length === 0) {
    lines.push('  PASS  All devDependency licenses are allowed.')
  } else {
    lines.push('  WARN  devDependencies with disallowed licenses (not gated):')
    for (const v of devViolations) {
      lines.push(`          ${v.license}:`)
      for (const pkg of v.packages) lines.push(`            - ${pkg}`)
    }
  }

  lines.push('')
  console.log(lines.join('\n'))

  if (prodViolations.length > 0) {
    console.error(
      'License gate failed: one or more production dependencies carry a license ' +
        'outside the allowlist. Add a named exception in scripts/license-gate.ts ' +
        '(with a documented reason) if the license is acceptable, or replace the ' +
        'dependency otherwise.',
    )
    process.exit(1)
  }
}

main()
