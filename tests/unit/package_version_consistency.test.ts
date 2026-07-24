/**
 * Version consistency guard for the two published packages.
 *
 * Three things must agree for every release, and they live in three different
 * files that nothing links together:
 *   1. `package.json`'s `version`
 *   2. the exported `CLI_VERSION` / `SDK_VERSION` constant (what `afr version`
 *      prints, and what the SDK stamps on ingest telemetry)
 *   3. the README's changelog, which is what a human actually reads to find
 *      out what changed
 *
 * These have drifted before. `SDK_VERSION === pkg.version` was already pinned
 * in sdk_observability.test.ts; this file adds the CLI's equivalent and, for
 * both packages, the README half — the one that drifted, and the one no test
 * covered, because a stale changelog is invisible to every other check in the
 * repo. A version bumped in package.json with no matching changelog entry is
 * a release whose consumers cannot tell what they are upgrading into.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

function readPackage(pkg: string): { version: string } {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../packages/${pkg}/package.json`, import.meta.url)), 'utf8'),
  ) as { version: string }
}

function readSource(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../../packages/${path}`, import.meta.url)), 'utf8')
}

const PACKAGES = [
  { name: 'cli', constant: 'CLI_VERSION' },
  { name: 'sdk', constant: 'SDK_VERSION' },
] as const

describe.each(PACKAGES)('$name — version is consistent across package.json, source, and README', ({ name, constant }) => {
  const pkgVersion = readPackage(name).version

  it('package.json version is a semver string', () => {
    expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it(`${constant} matches package.json`, () => {
    const source = readSource(`${name}/src/version.ts`)
    const match = new RegExp(`export const ${constant} = '([^']+)'`).exec(source)
    expect(match).not.toBeNull()
    expect(match![1]).toBe(pkgVersion)
  })

  /**
   * The README must document THIS version, not merely some version. Pinned as
   * a changelog line starting `v<version>` so a bump without an entry fails
   * here rather than shipping an undocumented release.
   */
  it('README has a changelog entry for exactly this version', () => {
    const readme = readSource(`${name}/README.md`)
    expect(readme).toContain(`v${pkgVersion} —`)
  })
})
