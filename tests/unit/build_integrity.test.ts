/**
 * Guard-the-guard tests for scripts/check-build-integrity.ts.
 *
 * The checker exists because of one specific incident: a field was deleted from
 * an interface in packages/sdk, `tsup`'s DTS step failed, the PREVIOUS
 * `dist/index.d.ts` survived, and `tsc --noEmit -p tests/tsconfig.json` then
 * passed at exit 0 while typechecking against types that no longer described the
 * source. A cold `rm -rf packages/*\/dist` does not catch that, because the
 * artifact came from a build that RAN and partially failed.
 *
 * So the central test here is not "does the checker run" — it is a byte-level
 * reconstruction of that dist directory on a real filesystem, with the real
 * mtime relationship a failed DTS step produces (JavaScript from THIS build,
 * declarations from the LAST one), asserted to be reported.
 *
 * Just as important are the negative tests. Every shape that is NOT a partial
 * build must stay silent, because a guard that cries wolf on a healthy tree is
 * one that gets removed from validate.sh within a week:
 *   - declarations NEWER than the JavaScript (the healthy tsup ordering, and the
 *     shape a slow DTS step on a loaded CI box produces),
 *   - every artifact written at the same instant (what a Turborepo cache restore
 *     produces),
 *   - packages that promise nothing in dist/ at all (apps/web, convex, tests).
 *
 * The final block runs the checker against the REAL repository. It is a standing
 * assertion that this workspace's own build outputs are intact right now.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import {
  analyzePackage,
  collectPackageState,
  declaredDistArtifacts,
  expandGlobs,
  formatReport,
  isCodeArtifact,
  isTypeArtifact,
  MTIME_EPSILON_MS,
  parseWorkspaceGlobs,
  run,
  type ArtifactFile,
  type PackageState,
} from '../../scripts/check-build-integrity.js'

const REPO_ROOT = path.resolve(__dirname, '../..')

const tempRoots: string[] = []

afterAll(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true })
})

/** package.json shape shared by packages/sdk and packages/contracts. */
const DUAL_EXPORT_PKG = {
  name: '@scope/widgets',
  version: '0.1.0',
  main: './dist/index.js',
  types: './dist/index.d.ts',
  exports: {
    '.': {
      import: { types: './dist/index.d.mts', default: './dist/index.mjs' },
      require: { types: './dist/index.d.ts', default: './dist/index.js' },
    },
  },
}

interface PlantedFile {
  name: string
  /** Seconds relative to the workspace's reference instant. Negative = older. */
  ageOffsetSeconds: number
  content?: string
}

/**
 * Build a throwaway workspace on the real filesystem with real mtimes.
 *
 * Real files rather than a mocked `fs` on purpose: the property under test IS a
 * filesystem property, and a mock would let the checker agree with a model of
 * the filesystem that the filesystem does not share.
 */
function plantWorkspace(files: PlantedFile[], pkgJson: unknown = DUAL_EXPORT_PKG): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'afr-build-integrity-'))
  tempRoots.push(root)

  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')

  const pkgDir = path.join(root, 'packages', 'widgets')
  fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkgJson, null, 2))

  const reference = Date.now()
  for (const file of files) {
    const abs = path.join(pkgDir, 'dist', file.name)
    fs.writeFileSync(abs, file.content ?? `/* ${file.name} */\n`)
    const stamp = new Date(reference + file.ageOffsetSeconds * 1000)
    fs.utimesSync(abs, stamp, stamp)
  }

  return root
}

/** A dist directory as a healthy tsup run leaves it: JS first, declarations last. */
const HEALTHY_DIST: PlantedFile[] = [
  { name: 'index.js', ageOffsetSeconds: -3 },
  { name: 'index.mjs', ageOffsetSeconds: -3 },
  { name: 'index.d.ts', ageOffsetSeconds: 0 },
  { name: 'index.d.mts', ageOffsetSeconds: 0 },
]

// ─────────────────────────────────────────────────────────────────────────────

describe('the incident: a failed DTS step leaves the previous declarations', () => {
  it('reports a PARTIAL_BUILD when declarations predate the JavaScript beside them', () => {
    // Exactly the dist tsup leaves behind when `--dts` fails and `--clean` is
    // off: index.js/index.mjs rewritten by THIS run, index.d.ts/index.d.mts
    // untouched survivors of the LAST successful one.
    const root = plantWorkspace([
      { name: 'index.js', ageOffsetSeconds: 0 },
      { name: 'index.mjs', ageOffsetSeconds: 0 },
      { name: 'index.d.ts', ageOffsetSeconds: -3600, content: 'export interface Widget { id: string; deletedField: string }\n' },
      { name: 'index.d.mts', ageOffsetSeconds: -3600, content: 'export interface Widget { id: string; deletedField: string }\n' },
    ])

    const { report, exitCode } = run(root)

    expect(exitCode).toBe(1)
    expect(report).toContain('PARTIAL_BUILD')
  })

  it('names the package, names the artifact, and says to rebuild that package', () => {
    // The whole value of the message. "Something is stale" sends the reader
    // hunting; this must hand them the package and the command.
    const root = plantWorkspace([
      { name: 'index.js', ageOffsetSeconds: 0 },
      { name: 'index.mjs', ageOffsetSeconds: 0 },
      { name: 'index.d.ts', ageOffsetSeconds: -3600 },
      { name: 'index.d.mts', ageOffsetSeconds: -3600 },
    ])

    const { report } = run(root)

    expect(report).toContain('@scope/widgets')
    expect(report).toContain('packages/widgets/dist/index.d.')
    expect(report).toContain('pnpm --filter @scope/widgets build')
  })

  it('catches an inversion far smaller than any "generous" staleness threshold', () => {
    // The real reproduction against tsup 8.5.1 produced an inversion of only
    // 10.8s, because the previous good build had been minutes earlier, not days.
    // A magnitude-based rule with the 60s or 90s tolerance it would have needed
    // to survive a slow CI box would have MISSED the actual incident. This is
    // why CHECK 2 is a direction test, not a magnitude test.
    const root = plantWorkspace([
      { name: 'index.js', ageOffsetSeconds: 0 },
      { name: 'index.mjs', ageOffsetSeconds: 0 },
      { name: 'index.d.ts', ageOffsetSeconds: -11 },
      { name: 'index.d.mts', ageOffsetSeconds: -11 },
    ])

    expect(run(root).exitCode).toBe(1)
  })

  it('flags the package even when only ONE of the two declaration files is stale', () => {
    // A half-written DTS phase is still a partial build.
    const root = plantWorkspace([
      { name: 'index.js', ageOffsetSeconds: 0 },
      { name: 'index.mjs', ageOffsetSeconds: 0 },
      { name: 'index.d.ts', ageOffsetSeconds: 0 },
      { name: 'index.d.mts', ageOffsetSeconds: -3600 },
    ])

    const { report, exitCode } = run(root)
    expect(exitCode).toBe(1)
    expect(report).toContain('index.d.mts')
  })
})

describe('the shape the root-cause fix produces: --clean, so no declarations at all', () => {
  it('reports MISSING_ARTIFACT for a declared file that was never emitted', () => {
    // `tsup --clean` wipes dist before building, so a failed DTS step leaves the
    // JavaScript with NO declarations rather than stale ones. packages/cli and
    // packages/mcp already build this way. CHECK 1 is what covers that shape,
    // and it is the check that stays load-bearing if contracts and sdk adopt
    // --clean too.
    const root = plantWorkspace([
      { name: 'index.js', ageOffsetSeconds: 0 },
      { name: 'index.mjs', ageOffsetSeconds: 0 },
    ])

    const { report, exitCode } = run(root)

    expect(exitCode).toBe(1)
    expect(report).toContain('MISSING_ARTIFACT')
    expect(report).toContain('index.d.ts')
    expect(report).toContain('index.d.mts')
  })

  it('reports MISSING_ARTIFACT when dist/ does not exist at all', () => {
    const root = plantWorkspace([])
    const { report, exitCode } = run(root)

    expect(exitCode).toBe(1)
    expect(report).toContain('MISSING_ARTIFACT')
  })

  it('reports EMPTY_ARTIFACT for a zero-byte emit', () => {
    // A truncated artifact parses as validly as a complete one, so size is the
    // only cheap signal that separates them.
    const root = plantWorkspace([
      ...HEALTHY_DIST.filter((f) => f.name !== 'index.d.ts'),
      { name: 'index.d.ts', ageOffsetSeconds: 0, content: '' },
    ])

    const { report, exitCode } = run(root)
    expect(exitCode).toBe(1)
    expect(report).toContain('EMPTY_ARTIFACT')
  })
})

describe('healthy trees stay silent', () => {
  it('passes on the ordering a healthy tsup run produces', () => {
    const root = plantWorkspace(HEALTHY_DIST)
    const { report, exitCode } = run(root)

    expect(exitCode).toBe(0)
    expect(report).toContain('All declared build artifacts are present')
  })

  it('does not flag declarations that are much NEWER than the JavaScript', () => {
    // A slow DTS step on a loaded CI runner. This is the healthy direction by
    // construction — tsup always emits declarations last — so bounding it would
    // buy nothing but false alarms on slow machines.
    const root = plantWorkspace([
      { name: 'index.js', ageOffsetSeconds: -600 },
      { name: 'index.mjs', ageOffsetSeconds: -600 },
      { name: 'index.d.ts', ageOffsetSeconds: 0 },
      { name: 'index.d.mts', ageOffsetSeconds: 0 },
    ])

    expect(run(root).exitCode).toBe(0)
  })

  it('does not flag a Turborepo cache restore, where every output shares one mtime', () => {
    // Observed in this repo: after a cached `pnpm build`, all four sdk artifacts
    // carried an identical timestamp. Zero skew must read as healthy.
    const root = plantWorkspace([
      { name: 'index.js', ageOffsetSeconds: 0 },
      { name: 'index.mjs', ageOffsetSeconds: 0 },
      { name: 'index.d.ts', ageOffsetSeconds: 0 },
      { name: 'index.d.mts', ageOffsetSeconds: 0 },
    ])

    expect(run(root).exitCode).toBe(0)
  })

  it('tolerates sub-epsilon jitter between concurrently written outputs', () => {
    const root = plantWorkspace([
      { name: 'index.js', ageOffsetSeconds: 0 },
      { name: 'index.mjs', ageOffsetSeconds: 0 },
      { name: 'index.d.ts', ageOffsetSeconds: -1 },
      { name: 'index.d.mts', ageOffsetSeconds: -1 },
    ])

    expect(MTIME_EPSILON_MS).toBe(2_000)
    expect(run(root).exitCode).toBe(0)
  })

  it('ignores non-emit files that share the dist directory', () => {
    // `tsc --noEmit` writes tsconfig.tsbuildinfo into packages/sdk/dist because
    // that package's tsconfig sets outDir there. It is neither code nor types
    // and must not move the verdict.
    const root = plantWorkspace([
      ...HEALTHY_DIST,
      { name: 'tsconfig.tsbuildinfo', ageOffsetSeconds: 900 },
      { name: 'index.js.map', ageOffsetSeconds: 900 },
    ])

    expect(run(root).exitCode).toBe(0)
  })
})

describe('what package.json promises is what gets checked', () => {
  it('extracts declaration paths from every leaf of a dual exports map', () => {
    // Checking only `types` would leave index.d.mts — half the declaration
    // surface of contracts and sdk — entirely unguarded.
    expect(declaredDistArtifacts(DUAL_EXPORT_PKG as unknown as Record<string, unknown>)).toEqual([
      'dist/index.d.mts',
      'dist/index.d.ts',
      'dist/index.js',
      'dist/index.mjs',
    ])
  })

  it('extracts the bin target, the shape packages/cli and packages/mcp use', () => {
    const declared = declaredDistArtifacts({
      name: '@scope/cli',
      bin: { afr: './dist/index.js' },
      main: './dist/index.js',
      types: './dist/index.d.ts',
    })

    expect(declared).toEqual(['dist/index.d.ts', 'dist/index.js'])
  })

  it('ignores paths that do not point into dist/', () => {
    const declared = declaredDistArtifacts({
      name: '@scope/web',
      main: './src/index.ts',
      exports: { './styles': './styles.css' },
    })

    expect(declared).toEqual([])
  })

  it('skips packages with no dist contract instead of inventing one', () => {
    // apps/web (.next), convex/ and tests/ land here. A package that promises
    // nothing in dist/ has no dist invariant to violate.
    const root = plantWorkspace(HEALTHY_DIST, { name: '@scope/app', private: true, scripts: { build: 'next build' } })

    // No dist contract anywhere in the workspace is a broken workspace or a
    // broken checker, and the checker says so rather than reporting a pass.
    const { exitCode } = run(root)
    expect(exitCode).toBe(2)
  })

  it('classifies .d.ts as a type artifact and never as a code artifact', () => {
    expect(isTypeArtifact('dist/index.d.ts')).toBe(true)
    expect(isTypeArtifact('dist/index.d.mts')).toBe(true)
    expect(isCodeArtifact('dist/index.d.ts')).toBe(false)
    expect(isCodeArtifact('dist/index.d.mts')).toBe(false)
    expect(isCodeArtifact('dist/index.js')).toBe(true)
    expect(isCodeArtifact('dist/index.mjs')).toBe(true)
  })
})

describe('workspace discovery cannot silently stop covering a package', () => {
  it('parses the globs out of pnpm-workspace.yaml', () => {
    expect(parseWorkspaceGlobs('packages:\n  - "apps/*"\n  - "packages/*"\n  - convex\n  - tests\n')).toEqual([
      'apps/*',
      'packages/*',
      'convex',
      'tests',
    ])
  })

  it('reports a glob shape it cannot expand rather than skipping it', () => {
    // A package this checker cannot see is a package it is not guarding, which
    // is the failure mode the whole file exists to prevent. Exit 2, not 0.
    const root = plantWorkspace(HEALTHY_DIST)
    fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/**/nested/*"\n')

    const { report, exitCode } = run(root)
    expect(exitCode).toBe(2)
    expect(report).toContain('UNCHECKED')
  })

  it('expands the real repository workspace to the four dist-producing packages', () => {
    const globs = parseWorkspaceGlobs(fs.readFileSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8'))
    const { dirs, unsupported } = expandGlobs(REPO_ROOT, globs)

    expect(unsupported).toEqual([])
    expect(dirs).toContain('packages/sdk')
    expect(dirs).toContain('packages/contracts')
    expect(dirs).toContain('packages/cli')
    expect(dirs).toContain('packages/mcp')
    expect(dirs).toContain('apps/web')
  })
})

describe('analyzePackage is pure and reports on plain data', () => {
  const file = (relPath: string, mtimeMs: number, size = 100): ArtifactFile => ({ relPath, mtimeMs, size })

  it('returns no findings for a coherent artifact set', () => {
    const state: PackageState = {
      packageName: '@scope/widgets',
      packageDir: 'packages/widgets',
      declared: ['packages/widgets/dist/index.js', 'packages/widgets/dist/index.d.ts'],
      present: [file('packages/widgets/dist/index.js', 1_000), file('packages/widgets/dist/index.d.ts', 3_000)],
    }

    expect(analyzePackage(state)).toEqual([])
  })

  it('returns a PARTIAL_BUILD finding carrying the offending artifact path', () => {
    const state: PackageState = {
      packageName: '@scope/widgets',
      packageDir: 'packages/widgets',
      declared: ['packages/widgets/dist/index.js', 'packages/widgets/dist/index.d.ts'],
      present: [file('packages/widgets/dist/index.js', 900_000), file('packages/widgets/dist/index.d.ts', 1_000)],
    }

    const findings = analyzePackage(state)
    expect(findings).toHaveLength(1)
    expect(findings[0].kind).toBe('PARTIAL_BUILD')
    expect(findings[0].artifact).toBe('packages/widgets/dist/index.d.ts')
    expect(findings[0].packageName).toBe('@scope/widgets')
  })

  it('makes no cross-class claim when a package emits only declarations', () => {
    // Absence is CHECK 1's business. CHECK 2 must not double-report it.
    const state: PackageState = {
      packageName: '@scope/types-only',
      packageDir: 'packages/types-only',
      declared: ['packages/types-only/dist/index.d.ts'],
      present: [file('packages/types-only/dist/index.d.ts', 1_000)],
    }

    expect(analyzePackage(state).filter((f) => f.kind === 'PARTIAL_BUILD')).toEqual([])
  })

  it('formats a passing report without a rebuild instruction', () => {
    const state: PackageState = {
      packageName: '@scope/widgets',
      packageDir: 'packages/widgets',
      declared: ['packages/widgets/dist/index.js'],
      present: [file('packages/widgets/dist/index.js', 1_000)],
    }

    const report = formatReport([state], [])
    expect(report).toContain('✓')
    expect(report).not.toContain('TO FIX')
  })
})

describe('the real repository', () => {
  it('has intact build artifacts right now', () => {
    // Standing regression test. If this fails, do not "fix the test": rebuild
    // the package it names and read the build output, which will be failing.
    const { report, exitCode } = run(REPO_ROOT)
    expect(report).toBeTruthy()
    expect(exitCode).toBe(0)
  })

  it('reads a real package.json off disk into a checkable state', () => {
    const state = collectPackageState(REPO_ROOT, 'packages/sdk')

    expect(state).not.toBeNull()
    expect(state?.packageName).toBe('@agent-flight-recorder/sdk')
    expect(state?.declared).toContain('packages/sdk/dist/index.d.ts')
    expect(state?.declared).toContain('packages/sdk/dist/index.d.mts')
  })

  it('treats apps/web as having no dist contract', () => {
    // Next.js writes .next, which nothing in this repo typechecks against, so a
    // partial Next build cannot lie to tsc the way a partial dist/ can.
    expect(collectPackageState(REPO_ROOT, 'apps/web')).toBeNull()
  })
})
