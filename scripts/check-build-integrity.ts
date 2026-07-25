#!/usr/bin/env tsx
/**
 * check-build-integrity.ts
 *
 * Detects STALE and PARTIAL build artifacts in `dist/` — the false-green class
 * where a build ran, failed halfway, and left the PREVIOUS output on disk so
 * that every downstream `tsc` keeps happily typechecking against yesterday's
 * types.
 *
 * ── The incident this exists for ────────────────────────────────────────────
 *
 * A field was deleted from an interface in packages/sdk to mutation-test a
 * guard. `tsc --noEmit -p tests/tsconfig.json` passed CLEAN at exit 0, because
 * `packages/sdk/dist/index.d.ts` still declared the deleted field. The package's
 * `tsup` run had failed at its DTS step and left the previous `.d.ts` in place.
 *
 * Note what that defeats: `rm -rf packages/*\/dist` does NOT catch it. The stale
 * artifact is produced by a build that RAN and partially failed, not by one that
 * never ran. A cold wipe cured every other false green in this project; it does
 * not cure this one.
 *
 * Reproduced directly (tsup 8.5.1, the repo's own version). Given a source edit
 * that esbuild accepts but tsc rejects, one `tsup src/index.ts --format esm,cjs
 * --dts` run produces:
 *
 *     -rw-r--r--  131 06:57:02.441  index.d.mts   <- PREVIOUS build, survived
 *     -rw-r--r--  131 06:57:02.441  index.d.ts    <- PREVIOUS build, survived
 *     -rw-r--r-- 1074 06:57:13.277  index.js      <- THIS build
 *     -rw-r--r--   76 06:57:13.277  index.mjs     <- THIS build
 *
 * and the surviving `index.d.ts` still declares the field that no longer exists
 * in `src`. That mtime inversion — TYPES OLDER THAN CODE — is the fingerprint,
 * and it is what CHECK 2 below tests.
 *
 * ── What "intact" means here ────────────────────────────────────────────────
 *
 * Two invariants, chosen because each one is a property a partial build actually
 * violates:
 *
 *   CHECK 1 — DECLARED, THEREFORE PRESENT.
 *     Every path a package's own package.json promises (`main`, `module`,
 *     `types`, `bin`, and every string leaf of `exports`) that points into
 *     `dist/` must exist and be non-empty.
 *
 *   CHECK 2 — ONE BUILD, ONE ARTIFACT SET.
 *     Within a package's `dist/`, the type artifacts (`.d.ts`/`.d.mts`/`.d.cts`)
 *     must not PREDATE the code artifacts (`.js`/`.mjs`/`.cjs`). tsup emits JS
 *     first and declarations last, so in a healthy build the declarations are
 *     always the newer of the two. Declarations older than the JavaScript beside
 *     them means the two files did not come from the same invocation — i.e. the
 *     DTS step failed and its predecessor survived.
 *
 * CHECK 2 needs no staleness threshold in the direction that matters, which is
 * the point. "Declarations are newer than the JS" is healthy by construction, no
 * matter how long the DTS step took on a slow CI box, so there is no upper bound
 * to tune and no slow-runner false alarm. Only the inverted direction is
 * reported, with a 2s epsilon for filesystem granularity and parallel writes.
 * (In the reproduction above the inversion was just 10.8s. A guard with the
 * "generous" 60s or 90s threshold that a magnitude-based rule would have wanted
 * would have MISSED the real incident.)
 *
 * ── Candidates deliberately REJECTED ────────────────────────────────────────
 *
 * A guard that checks the wrong property is worse than no guard, because it
 * manufactures confidence. These were considered and rejected:
 *
 *   ✗ "`.d.ts` must be newer than the `src/**` it derives from."
 *     Rejected. Turborepo hashes CONTENT: touching a source without changing it
 *     (a formatter pass, an editor save, a branch switch) is a cache HIT, so
 *     turbo skips the task and never rewrites `dist/`. The source is then
 *     permanently newer than the artifact and this check screams forever, curable
 *     only by a forced rebuild. That is precisely the check developers learn to
 *     ignore. CHECK 2 catches the real incident without consulting `src` at all.
 *
 *   ✗ "Every export named in `src/index.ts` must appear in the emitted `.d.ts`."
 *     Rejected, and this is the important one: the incident deleted a FIELD FROM
 *     AN INTERFACE, not an export. `Widget` was exported before and after; only
 *     its shape drifted. This check would have passed, cleanly, on the exact
 *     artifact that caused the outage — while looking thorough enough that
 *     nobody would have looked further. It is also fragile across `export *`,
 *     re-exports and renames.
 *
 *   ✗ "The emitted `.d.ts` parses."
 *     Rejected. Yesterday's `.d.ts` parses perfectly — that is the whole problem.
 *     It costs a TypeScript parse per package and catches nothing in this class.
 *     Non-emptiness is kept (it is one `stat`, and a zero-byte artifact is always
 *     wrong), but parsing is not.
 *
 *   ✗ "Write a content-hash manifest of the inputs into `dist/` at build time."
 *     The correct general answer, and rejected only on ownership and duplication
 *     grounds: it requires editing every package's build script (`packages/**`),
 *     and it re-implements the input hashing Turborepo already does.
 *
 *   ✗ `apps/web/.next`.
 *     Skipped on purpose. Nothing in the repo typechecks against `.next`, so a
 *     partial Next build cannot lie to `tsc` the way a partial `dist` can. It
 *     would add cost and catch nothing in this class.
 *
 * ── Relationship to the root-cause fix ──────────────────────────────────────
 *
 * tsup ALREADY fails loudly: a failed DTS step exits 1. The defect is not a
 * silent exit 0, it is that the failed run leaves the previous `.d.ts` behind.
 * `packages/cli` and `packages/mcp` set `clean: true` and therefore do not;
 * `packages/contracts` and `packages/sdk` build without `--clean` and therefore
 * do. Adding `--clean` to those two build scripts (packages/** — Team C's call)
 * is the right prevention, and it converts a CHECK 2 failure into a CHECK 1
 * failure: no stale `.d.ts`, just an absent one. Both checks stay useful, because
 * they assert the OUTCOME rather than trusting anyone's build flags to stay put.
 *
 * Exit codes:
 *   0  all build artifacts intact
 *   1  at least one missing / empty / stale artifact  (a real finding)
 *   2  the checker itself could not run (unreadable workspace, bad JSON)
 *
 * Run: pnpm tsx scripts/check-build-integrity.ts     (AFTER a build)
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.join(__dirname, '..')

/**
 * Slack allowed when comparing type-artifact mtimes against code-artifact
 * mtimes, in milliseconds. Absorbs filesystem timestamp granularity and the
 * fact that tsup writes the ESM and CJS outputs concurrently. It does NOT need
 * to absorb DTS build duration: a slow DTS step makes declarations NEWER, which
 * is the healthy direction and is never reported.
 */
export const MTIME_EPSILON_MS = 2_000

const TYPE_EXTENSIONS = ['.d.ts', '.d.mts', '.d.cts']
const CODE_EXTENSIONS = ['.js', '.mjs', '.cjs']

export type FindingKind = 'MISSING_ARTIFACT' | 'EMPTY_ARTIFACT' | 'PARTIAL_BUILD'

export interface Finding {
  kind: FindingKind
  /** npm package name, e.g. "@agent-flight-recorder/sdk". */
  packageName: string
  /** Repo-relative package directory, e.g. "packages/sdk". */
  packageDir: string
  /** Repo-relative artifact path the finding is about. */
  artifact: string
  /** Human-readable detail lines. */
  detail: string[]
}

/** One file observed inside a package's dist/, reduced to what the checks need. */
export interface ArtifactFile {
  /** Path relative to the repo root. */
  relPath: string
  mtimeMs: number
  size: number
}

/** Everything the analysis needs about one package. Deliberately plain data. */
export interface PackageState {
  packageName: string
  /** Repo-relative package directory. */
  packageDir: string
  /** Repo-relative paths promised by package.json that point into dist/. */
  declared: string[]
  /** Every file actually found under the package's dist/. */
  present: ArtifactFile[]
}

// ─── Workspace discovery ──────────────────────────────────────────────────────

/**
 * Extract the package globs from pnpm-workspace.yaml.
 *
 * Deliberately a line scanner rather than a YAML dependency: the file is a
 * single `packages:` list of scalars, and this script must stay dependency-free
 * so it can run before/independently of a full install.
 */
export function parseWorkspaceGlobs(yamlText: string): string[] {
  const globs: string[] = []
  let inPackages = false

  for (const rawLine of yamlText.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trimEnd()
    if (line.trim() === '') continue

    if (/^packages:\s*$/.test(line)) {
      inPackages = true
      continue
    }
    if (!inPackages) continue

    const item = /^\s*-\s*(.+)$/.exec(line)
    if (item === null) {
      // A new top-level key ends the packages list.
      if (/^\S/.test(line)) inPackages = false
      continue
    }
    globs.push((item[1] ?? '').trim().replace(/^['"]|['"]$/g, ''))
  }

  return globs
}

/**
 * Resolve workspace globs to repo-relative package directories.
 *
 * Only the two shapes pnpm-workspace.yaml actually uses are supported —
 * a literal directory ("convex") and a single-level wildcard ("packages/*").
 * Anything else is reported rather than silently skipped, because a glob this
 * script cannot expand is a package it is not checking, and a guard that
 * silently stops covering things is the failure mode this whole file exists to
 * prevent.
 */
export function expandGlobs(repoRoot: string, globs: string[]): { dirs: string[]; unsupported: string[] } {
  const dirs: string[] = []
  const unsupported: string[] = []

  for (const glob of globs) {
    if (glob.startsWith('!')) continue

    if (!glob.includes('*')) {
      if (fs.existsSync(path.join(repoRoot, glob, 'package.json'))) dirs.push(glob)
      continue
    }

    const singleLevel = /^([^*]+)\/\*$/.exec(glob)
    if (singleLevel === null) {
      unsupported.push(glob)
      continue
    }

    const parent = singleLevel[1] ?? ''
    const parentAbs = path.join(repoRoot, parent)
    if (!fs.existsSync(parentAbs)) continue

    for (const entry of fs.readdirSync(parentAbs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const rel = `${parent}/${entry.name}`
      if (fs.existsSync(path.join(repoRoot, rel, 'package.json'))) dirs.push(rel)
    }
  }

  return { dirs: [...new Set(dirs)].sort(), unsupported }
}

// ─── What a package.json promises ─────────────────────────────────────────────

/** Collect every string leaf of an `exports` map, at any nesting depth. */
function collectExportLeaves(node: unknown, out: string[]): void {
  if (typeof node === 'string') {
    out.push(node)
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) collectExportLeaves(child, out)
    return
  }
  if (node !== null && typeof node === 'object') {
    for (const child of Object.values(node as Record<string, unknown>)) collectExportLeaves(child, out)
  }
}

/**
 * Every path a package.json promises that points into `dist/`, normalised to a
 * package-relative path ("dist/index.d.ts").
 *
 * `main`, `module`, `types`, `typings`, `bin` and `exports` are all consulted,
 * because each of them is a promise some consumer resolves. `exports` matters
 * most: contracts and sdk route `import` at `dist/index.d.mts` and `require` at
 * `dist/index.d.ts`, so checking only `types` would leave the `.d.mts` — half of
 * the declaration surface — entirely unguarded.
 */
export function declaredDistArtifacts(pkgJson: Record<string, unknown>): string[] {
  const candidates: string[] = []

  for (const field of ['main', 'module', 'types', 'typings'] as const) {
    const value = pkgJson[field]
    if (typeof value === 'string') candidates.push(value)
  }

  const bin = pkgJson['bin']
  if (typeof bin === 'string') candidates.push(bin)
  else if (bin !== null && typeof bin === 'object') collectExportLeaves(bin, candidates)

  if ('exports' in pkgJson) collectExportLeaves(pkgJson['exports'], candidates)

  const normalised = candidates
    .map((p) => p.replace(/^\.\//, ''))
    .filter((p) => p.startsWith('dist/'))
    .map((p) => path.posix.normalize(p))

  return [...new Set(normalised)].sort()
}

// ─── Filesystem collection ────────────────────────────────────────────────────

function listFilesRecursive(absDir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const abs = path.join(absDir, entry.name)
    if (entry.isDirectory()) listFilesRecursive(abs, out)
    else if (entry.isFile()) out.push(abs)
  }
  return out
}

/** Read one package into the plain-data shape `analyzePackage` consumes. */
export function collectPackageState(repoRoot: string, packageDir: string): PackageState | null {
  const pkgPath = path.join(repoRoot, packageDir, 'package.json')
  const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
  const packageName = typeof pkgJson['name'] === 'string' ? pkgJson['name'] : packageDir

  const declaredRelToPkg = declaredDistArtifacts(pkgJson)

  // A package that promises nothing in dist/ has no dist contract to violate.
  // apps/web (.next), convex/ and tests/ land here and are skipped by design.
  if (declaredRelToPkg.length === 0) return null

  const distAbs = path.join(repoRoot, packageDir, 'dist')
  const present: ArtifactFile[] = []

  if (fs.existsSync(distAbs)) {
    for (const abs of listFilesRecursive(distAbs)) {
      const stat = fs.statSync(abs)
      present.push({
        relPath: path.posix.join(packageDir, path.relative(path.join(repoRoot, packageDir), abs).split(path.sep).join('/')),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      })
    }
  }

  return {
    packageName,
    packageDir,
    declared: declaredRelToPkg.map((p) => path.posix.join(packageDir, p)),
    present: present.sort((a, b) => a.relPath.localeCompare(b.relPath)),
  }
}

// ─── The checks ───────────────────────────────────────────────────────────────

function hasExtension(relPath: string, extensions: string[]): boolean {
  return extensions.some((ext) => relPath.endsWith(ext))
}

export function isTypeArtifact(relPath: string): boolean {
  return hasExtension(relPath, TYPE_EXTENSIONS)
}

export function isCodeArtifact(relPath: string): boolean {
  // `.d.ts` also ends in `.ts`, and `.d.mts` in `.mts` — but neither ends in a
  // CODE extension, so the type check only needs to be excluded explicitly for
  // safety against future extension lists.
  return !isTypeArtifact(relPath) && hasExtension(relPath, CODE_EXTENSIONS)
}

function newestOf(files: ArtifactFile[]): ArtifactFile | undefined {
  let newest: ArtifactFile | undefined
  for (const file of files) {
    if (newest === undefined || file.mtimeMs > newest.mtimeMs) newest = file
  }
  return newest
}

function oldestOf(files: ArtifactFile[]): ArtifactFile | undefined {
  let oldest: ArtifactFile | undefined
  for (const file of files) {
    if (oldest === undefined || file.mtimeMs < oldest.mtimeMs) oldest = file
  }
  return oldest
}

/**
 * Apply both checks to one package. Pure: takes plain data, returns findings.
 */
export function analyzePackage(state: PackageState, epsilonMs: number = MTIME_EPSILON_MS): Finding[] {
  const findings: Finding[] = []
  const byPath = new Map(state.present.map((f) => [f.relPath, f]))

  // ── CHECK 1 — declared, therefore present (and non-empty) ──
  for (const declared of state.declared) {
    const file = byPath.get(declared)

    if (file === undefined) {
      findings.push({
        kind: 'MISSING_ARTIFACT',
        packageName: state.packageName,
        packageDir: state.packageDir,
        artifact: declared,
        detail: [
          `${state.packageName} declares "${declared.slice(state.packageDir.length + 1)}" in its package.json,`,
          `but ${declared} does not exist.`,
          'A build step that emits this file did not run, or ran and failed.',
        ],
      })
      continue
    }

    if (file.size === 0) {
      findings.push({
        kind: 'EMPTY_ARTIFACT',
        packageName: state.packageName,
        packageDir: state.packageDir,
        artifact: declared,
        detail: [`${declared} exists but is 0 bytes — the build that wrote it did not finish.`],
      })
    }
  }

  // ── CHECK 2 — one build, one artifact set ──
  const typeFiles = state.present.filter((f) => isTypeArtifact(f.relPath))
  const codeFiles = state.present.filter((f) => isCodeArtifact(f.relPath))

  // With only one class present there is no cross-class claim to make. A wholly
  // absent class is CHECK 1's business, not this one's.
  if (typeFiles.length > 0 && codeFiles.length > 0) {
    const newestCode = newestOf(codeFiles)
    const oldestType = oldestOf(typeFiles)

    if (newestCode !== undefined && oldestType !== undefined) {
      const lagMs = newestCode.mtimeMs - oldestType.mtimeMs
      if (lagMs > epsilonMs) {
        findings.push({
          kind: 'PARTIAL_BUILD',
          packageName: state.packageName,
          packageDir: state.packageDir,
          artifact: oldestType.relPath,
          detail: [
            `${oldestType.relPath} is ${formatDuration(lagMs)} OLDER than ${newestCode.relPath}.`,
            'These two files did not come from the same build. tsup emits JavaScript',
            'first and declarations last, so healthy declarations are always the newer',
            'of the pair.',
            '',
            'The overwhelmingly likely cause is a build whose DTS step FAILED while its',
            'JavaScript step succeeded, leaving the PREVIOUS declaration file on disk.',
            `Every \`tsc\` in this repo is currently typechecking ${state.packageName}`,
            'against those stale types, and will keep reporting success for code that',
            'does not compile.',
          ],
        })
      }
    }
  }

  return findings
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 90) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

// ─── Reporting ────────────────────────────────────────────────────────────────

export function formatReport(states: PackageState[], findings: Finding[]): string {
  const lines: string[] = []
  lines.push('')
  lines.push('Agent Flight Recorder — Build Integrity Check')
  lines.push('─'.repeat(60))

  const failedPackages = new Set(findings.map((f) => f.packageName))

  for (const state of states) {
    const mark = failedPackages.has(state.packageName) ? '✗' : '✓'
    lines.push(`  ${mark}  ${state.packageName}  (${state.declared.length} declared artifact(s))`)
  }

  if (findings.length === 0) {
    lines.push('')
    lines.push('All declared build artifacts are present, non-empty, and internally consistent.')
    lines.push('')
    return lines.join('\n')
  }

  lines.push('')
  lines.push(`${findings.length} problem(s) found.`)

  // Group by package so the reader gets one rebuild instruction per package.
  const byPackage = new Map<string, Finding[]>()
  for (const finding of findings) {
    const existing = byPackage.get(finding.packageName)
    if (existing === undefined) byPackage.set(finding.packageName, [finding])
    else existing.push(finding)
  }

  for (const [packageName, packageFindings] of byPackage) {
    lines.push('')
    lines.push(`  ${packageName}`)
    for (const finding of packageFindings) {
      lines.push(`    ${finding.kind}  ${finding.artifact}`)
      for (const detail of finding.detail) {
        lines.push(detail === '' ? '' : `      ${detail}`)
      }
    }
    lines.push('')
    lines.push(`    TO FIX — rebuild this package and READ THE OUTPUT, it will fail:`)
    lines.push(`      pnpm --filter ${packageName} build`)
  }

  lines.push('')
  lines.push('A `rm -rf packages/*/dist` will NOT surface this class of problem: the')
  lines.push('artifact was written by a build that ran and partially failed, not by one')
  lines.push('that never ran. Rebuild the named package and fix the error it prints.')
  lines.push('')

  return lines.join('\n')
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export function run(repoRoot: string = REPO_ROOT): { report: string; exitCode: 0 | 1 | 2 } {
  let globs: string[]
  try {
    globs = parseWorkspaceGlobs(fs.readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'))
  } catch (error) {
    return {
      report: `check-build-integrity: cannot read pnpm-workspace.yaml — ${String(error)}`,
      exitCode: 2,
    }
  }

  const { dirs, unsupported } = expandGlobs(repoRoot, globs)
  if (unsupported.length > 0) {
    return {
      report:
        `check-build-integrity: pnpm-workspace.yaml contains glob(s) this checker cannot expand: ` +
        `${unsupported.join(', ')}. Packages matched by them would go UNCHECKED, so this is a hard\n` +
        `error rather than a skip. Teach expandGlobs() the new shape in scripts/check-build-integrity.ts.`,
      exitCode: 2,
    }
  }

  const states: PackageState[] = []
  try {
    for (const dir of dirs) {
      const state = collectPackageState(repoRoot, dir)
      if (state !== null) states.push(state)
    }
  } catch (error) {
    return { report: `check-build-integrity: ${String(error)}`, exitCode: 2 }
  }

  if (states.length === 0) {
    return {
      report:
        'check-build-integrity: no workspace package declares a dist/ artifact. That is either a\n' +
        'broken workspace or a broken checker — neither is a pass.',
      exitCode: 2,
    }
  }

  const findings = states.flatMap((state) => analyzePackage(state))
  return { report: formatReport(states, findings), exitCode: findings.length > 0 ? 1 : 0 }
}

// Only self-execute when invoked as a script, so tests can import the pure
// functions above without the process exiting underneath them.
const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(__filename)

if (invokedDirectly) {
  const { report, exitCode } = run()
  if (exitCode === 0) console.log(report)
  else console.error(report)
  process.exit(exitCode)
}
