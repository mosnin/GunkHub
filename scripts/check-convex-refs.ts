#!/usr/bin/env tsx
/**
 * check-convex-refs.ts
 *
 * Mechanical guard for the `apps/web/src/lib/convexFunctions.ts` seam.
 *
 * WHY THIS EXISTS
 * ---------------
 * `apps/web/src/lib/convexFunctions.ts` is a hand-maintained table of
 * `makeFunctionReference<Q|M|A>('module:functionName')` string refs. Convex's
 * generated `api.*` bindings are not used here (convex/_generated/api.ts is a
 * hand-authored `anyApi` stub so the backend typechecks without a live
 * deployment), so `anyApi` resolves ANY property path and ANY string ref
 * typechecks. That means TypeScript checks NOTHING about these refs:
 *
 *   - a ref naming a function that does not exist  -> typechecks, 404s at runtime
 *   - a ref with the wrong module path             -> typechecks, 404s at runtime
 *   - a ref typed <Q> for an actual `mutation`     -> typechecks, throws at runtime
 *   - a call site passing an arg the validator     -> typechecks, ArgumentValidationError
 *     does not declare / omitting a required one
 *
 * That class of bug has shipped repeatedly, including silently (a declared
 * param dropped from a forwarding object spread). This script closes it
 * statically: it parses the real convex/*.ts modules with the TypeScript
 * compiler API (already a devDependency — no new deps) and cross-checks every
 * ref and every direct call site against them. It needs no Convex deployment,
 * no network, and no build, so it runs as its own CI job.
 *
 * WHAT IT CHECKS
 * --------------
 *   1. REF RESOLUTION   every ref in convexFunctions.ts resolves to a real
 *                       registered function: module file exists, function is
 *                       exported and registered, is PUBLIC (not internal*),
 *                       and its declared kind (Q/M/A) matches the real
 *                       registration.
 *   2. REVERSE COVERAGE public functions in modules the web app already
 *                       depends on must be registered in the table (see
 *                       "REVERSE COVERAGE RULE" below for the scoping rule).
 *   3. CALL-SITE KIND   `client.query(convex.x.y, ...)` must use the method
 *                       matching the real registration kind.
 *   4. CALL-SITE ARGS   a literal args object at a call site must not pass
 *                       keys the Convex `args` validator does not declare,
 *                       and must not omit a required (non-`v.optional`) one.
 *                       Skipped for call sites using spreads or non-literal
 *                       args, and for functions whose `args` is not a literal
 *                       object (those are unenumerable statically).
 *
 * Exits non-zero with a per-problem report naming the exact ref, its source
 * location, what is wrong, and the fix.
 *
 * Run: pnpm tsx scripts/check-convex-refs.ts
 *      pnpm tsx scripts/check-convex-refs.ts --list   # dump the parsed inventory
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const __filename_ = fileURLToPath(import.meta.url)
const REPO_ROOT = path.join(path.dirname(__filename_), '..')

const CONVEX_DIR = path.join(REPO_ROOT, 'convex')
const REFS_FILE = path.join(REPO_ROOT, 'apps/web/src/lib/convexFunctions.ts')
const WEB_SRC = path.join(REPO_ROOT, 'apps/web/src')

// ─── Reverse coverage rule ────────────────────────────────────────────────────
//
// REVERSE COVERAGE RULE (justification — read before changing):
//
//   A convex function must have a ref in convexFunctions.ts when ALL of:
//     (a) it is PUBLIC — registered with query()/mutation()/action(), not
//         internalQuery()/internalMutation()/internalAction();
//     (b) it lives in a WEB-FACING MODULE — one for which convexFunctions.ts
//         already registers at least one ref;
//     (c) it is on the WEB'S AUTH SURFACE — i.e. its args validator does NOT
//         declare `apiKeyHash` (API-key-authed SDK/CLI surface) or
//         `webhookSecret` (Clerk-webhook-authed surface).
//
// Why each clause:
//   (a) `internal*` functions are unreachable from any client and are addressed
//       server-side via `internal.*`. Requiring refs for them would be wrong,
//       not merely noisy.
//   (b) Opting a module in by first use is what keeps this direction sharp.
//       Once the web app depends on a module AT ALL, a newly added public
//       function in it is overwhelmingly likely to be meant for the web app,
//       and "landed the Convex function, forgot the ref" is precisely the
//       failure this direction exists to catch. Demanding refs for modules the
//       web app has never touched would instead force dead bindings into the
//       table — the opposite of the goal.
//   (c) The auth surface is readable straight off the args validator and is not
//       a matter of opinion: a function taking `apiKeyHash` authenticates an
//       API key (SDK/CLI callers) and a function taking `webhookSecret`
//       authenticates a Clerk webhook. Neither is reachable by the Clerk-JWT
//       web client on its own account, so absence of a ref is not a defect.
//       (Refs for such functions are still ALLOWED and several exist — the web
//       app proxies the key-authed read API in services/api_v1.ts — clause (c)
//       only removes the *obligation*.)
//
// Escape hatch: add an entry below. A justification string is REQUIRED — the
// type makes an undocumented exemption impossible. Exemptions are themselves
// checked: one that is no longer needed (the function gained a ref, or no
// longer exists) is a failure, so this list cannot rot into a blanket mute.
const REVERSE_COVERAGE_EXEMPTIONS: ReadonlyArray<{
  readonly ref: string // 'module:functionName'
  readonly reason: string
}> = [
  {
    ref: 'artifacts:createArtifact',
    reason:
      'Artifacts are created on the ingest path (sdk_ingest:sdkCreateArtifact, the API-key-authed twin). ' +
      'The web app renders artifacts but has no creation surface; a ref would be a dead binding. ' +
      'Delete this entry the moment the UI gains an upload surface.',
  },
  {
    ref: 'projects:updateProject',
    reason:
      'Public Clerk-authed mutation with no web call site as of 2026-07-24 — the project edit UI does not exist yet. ' +
      'Backend-ahead-of-UI, not drift. Delete this entry when the edit surface lands and add the ref.',
  },
  {
    ref: 'runs:updateRunStatus',
    reason:
      'Run status transitions are owned by the recorder (SDK -> sdk_ingest:sdkUpdateRunStatus) and by the ' +
      'stale-run cron; the web app deliberately never mutates run status by hand. Delete this entry only ' +
      'alongside a decision that operators may transition runs from the UI.',
  },
]

// ─── Types ────────────────────────────────────────────────────────────────────

type FnKind = 'query' | 'mutation' | 'action'

interface ConvexFn {
  readonly module: string // e.g. 'failure_patterns'
  readonly name: string
  readonly kind: FnKind
  readonly internal: boolean
  readonly file: string // repo-relative
  readonly line: number
  /** Declared arg names -> required?  `null` when `args` is not statically enumerable. */
  readonly args: Map<string, { required: boolean }> | null
}

interface Ref {
  readonly objectPath: string // e.g. 'convex.explanations.getRunExplanation'
  readonly refString: string // e.g. 'run_explanations:getRunExplanation'
  readonly module: string
  readonly name: string
  readonly declaredKind: FnKind
  readonly line: number
}

interface Problem {
  readonly title: string
  readonly lines: readonly string[]
}

// ─── Small helpers ────────────────────────────────────────────────────────────

const RED = '[0;31m'
const GREEN = '[0;32m'
const YELLOW = '[1;33m'
const DIM = '[2m'
const BOLD = '[1m'
const RESET = '[0m'

const rel = (p: string): string => path.relative(REPO_ROOT, p)

function parseFile(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function lineOf(node: ts.Node, sf: ts.SourceFile): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function propName(p: ts.ObjectLiteralElementLike): string | null {
  const n = p.name
  if (n === undefined) return null
  if (ts.isIdentifier(n) || ts.isStringLiteral(n)) return n.text
  return null
}

/** Levenshtein-lite: is `a` a plausible typo of `b`? Used only for "did you mean". */
function close(a: string, b: string): boolean {
  if (a === b) return true
  const al = a.toLowerCase()
  const bl = b.toLowerCase()
  return al === bl || al.includes(bl) || bl.includes(al)
}

// ─── 1. Parse the convex modules ──────────────────────────────────────────────

const REGISTRARS: Record<string, { kind: FnKind; internal: boolean }> = {
  query: { kind: 'query', internal: false },
  mutation: { kind: 'mutation', internal: false },
  action: { kind: 'action', internal: false },
  internalQuery: { kind: 'query', internal: true },
  internalMutation: { kind: 'mutation', internal: true },
  internalAction: { kind: 'action', internal: true },
}

function parseArgsValidator(config: ts.ObjectLiteralExpression): Map<string, { required: boolean }> | null {
  const argsProp = config.properties.find((p) => propName(p) === 'args')
  if (argsProp === undefined) return new Map() // no args -> takes {}
  if (!ts.isPropertyAssignment(argsProp)) return null
  const init = argsProp.initializer
  if (!ts.isObjectLiteralExpression(init)) return null // e.g. `args: sharedArgs`

  const out = new Map<string, { required: boolean }>()
  for (const p of init.properties) {
    if (ts.isSpreadAssignment(p)) return null // partially unknown -> treat as unenumerable
    const name = propName(p)
    if (name === null) return null
    let required = true
    if (ts.isPropertyAssignment(p)) {
      const text = p.initializer.getText().replace(/\s+/g, '')
      if (text.startsWith('v.optional(')) required = false
    }
    out.set(name, { required })
  }
  return out
}

export function parseConvexModules(convexDir: string = CONVEX_DIR): Map<string, ConvexFn> {
  const fns = new Map<string, ConvexFn>() // key: 'module:name'
  const files = fs
    .readdirSync(convexDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
    .sort()

  for (const f of files) {
    const moduleName = f.replace(/\.ts$/, '')
    const full = path.join(convexDir, f)
    const sf = parseFile(full)

    for (const stmt of sf.statements) {
      if (!ts.isVariableStatement(stmt)) continue
      const exported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
      if (!exported) continue

      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue
        const init = decl.initializer
        if (init === undefined || !ts.isCallExpression(init)) continue
        if (!ts.isIdentifier(init.expression)) continue
        const registrar = REGISTRARS[init.expression.text]
        if (registrar === undefined) continue

        const configArg = init.arguments[0]
        const args =
          configArg !== undefined && ts.isObjectLiteralExpression(configArg)
            ? parseArgsValidator(configArg)
            : null

        fns.set(`${moduleName}:${decl.name.text}`, {
          module: moduleName,
          name: decl.name.text,
          kind: registrar.kind,
          internal: registrar.internal,
          file: rel(full),
          line: lineOf(decl, sf),
          args,
        })
      }
    }
  }
  return fns
}

// ─── 2. Parse convexFunctions.ts ──────────────────────────────────────────────

export function parseRefs(refsFile: string = REFS_FILE): Ref[] {
  const sf = parseFile(refsFile)

  // `type Q = 'query'` etc.
  const aliases = new Map<string, FnKind>()
  for (const stmt of sf.statements) {
    if (!ts.isTypeAliasDeclaration(stmt)) continue
    const t = stmt.type
    if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) {
      const lit = t.literal.text
      if (lit === 'query' || lit === 'mutation' || lit === 'action') aliases.set(stmt.name.text, lit)
    }
  }

  const refs: Ref[] = []

  const objectPathOf = (node: ts.Node): string => {
    const parts: string[] = []
    let cur: ts.Node | undefined = node
    while (cur !== undefined) {
      if (ts.isPropertyAssignment(cur)) {
        const n = propName(cur)
        if (n !== null) parts.unshift(n)
      } else if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) {
        parts.unshift(cur.name.text)
      }
      cur = cur.parent
    }
    return parts.join('.')
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'makeFunctionReference'
    ) {
      const typeArg = node.typeArguments?.[0]
      let kind: FnKind | undefined
      if (typeArg !== undefined) {
        if (ts.isTypeReferenceNode(typeArg) && ts.isIdentifier(typeArg.typeName)) {
          kind = aliases.get(typeArg.typeName.text)
        } else if (ts.isLiteralTypeNode(typeArg) && ts.isStringLiteral(typeArg.literal)) {
          const lit = typeArg.literal.text
          if (lit === 'query' || lit === 'mutation' || lit === 'action') kind = lit
        }
      }
      const arg0 = node.arguments[0]
      if (kind !== undefined && arg0 !== undefined && ts.isStringLiteral(arg0)) {
        const refString = arg0.text
        const colon = refString.indexOf(':')
        refs.push({
          objectPath: objectPathOf(node),
          refString,
          module: colon === -1 ? refString : refString.slice(0, colon),
          name: colon === -1 ? '' : refString.slice(colon + 1),
          declaredKind: kind,
          line: lineOf(node, sf),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return refs
}

// ─── 3. Parse web call sites ──────────────────────────────────────────────────

interface CallSite {
  readonly file: string
  readonly line: number
  readonly objectPath: string // 'convex.runs.getRun'
  readonly method: FnKind
  readonly methodText: string // 'client.query' / 'useQuery'
  /** Literal arg keys, or null when not statically enumerable (spread / non-literal). */
  readonly argKeys: Set<string> | null
}

const HOOK_KINDS: Record<string, FnKind> = {
  useQuery: 'query',
  useMutation: 'mutation',
  useAction: 'action',
}

function walkWebFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue
      walkWebFiles(p, out)
    } else if (p.endsWith('.ts') || p.endsWith('.tsx')) {
      out.push(p)
    }
  }
  return out
}

function parseCallSites(webSrc: string, refsFile: string): { sites: CallSite[]; usages: number } {
  const sites: CallSite[] = []
  let webRefUsages = 0
  for (const file of walkWebFiles(webSrc).filter((f) => f !== refsFile)) {
    const text = fs.readFileSync(file, 'utf8')
    if (!text.includes('convex.')) continue
    const sf = parseFile(file)

    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'convex'
      ) {
        webRefUsages += 1
      }
      if (ts.isCallExpression(node)) {
        let method: FnKind | undefined
        let methodText = ''
        let refArgIndex = 0

        if (ts.isPropertyAccessExpression(node.expression)) {
          const m = node.expression.name.text
          if (m === 'query' || m === 'mutation' || m === 'action') {
            method = m
            methodText = node.expression.getText(sf)
          }
        } else if (ts.isIdentifier(node.expression)) {
          const hook = HOOK_KINDS[node.expression.text]
          if (hook !== undefined) {
            method = hook
            methodText = node.expression.text
          }
        }

        const refArg = node.arguments[refArgIndex]
        if (
          method !== undefined &&
          refArg !== undefined &&
          ts.isPropertyAccessExpression(refArg) &&
          refArg.expression.getText(sf).startsWith('convex.')
        ) {
          const objectPath = refArg.getText(sf)
          const argsArg = node.arguments[refArgIndex + 1]
          let argKeys: Set<string> | null = null
          if (argsArg !== undefined && ts.isObjectLiteralExpression(argsArg)) {
            const keys = new Set<string>()
            let enumerable = true
            for (const p of argsArg.properties) {
              if (ts.isSpreadAssignment(p)) {
                enumerable = false
                break
              }
              const n = propName(p)
              if (n === null) {
                enumerable = false
                break
              }
              keys.add(n)
            }
            argKeys = enumerable ? keys : null
          }
          sites.push({
            file: rel(file),
            line: lineOf(node, sf),
            objectPath,
            method,
            methodText,
            argKeys,
          })
        }
        refArgIndex = 0
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return { sites, usages: webRefUsages }
}

// ─── 4. Checks ────────────────────────────────────────────────────────────────

const KIND_TYPEPARAM: Record<FnKind, string> = { query: '<Q>', mutation: '<M>', action: '<A>' }
const KIND_CLIENT: Record<FnKind, string> = {
  query: 'client.query(...)',
  mutation: 'client.mutation(...)',
  action: 'client.action(...)',
}

export interface AnalyzeOptions {
  /** Directory holding the convex modules (convex/*.ts). */
  readonly convexDir?: string
  /** The hand-maintained ref table. */
  readonly refsFile?: string
  /** Root of the web sources scanned for call sites. */
  readonly webSrc?: string
  /** Reverse-coverage exemptions; defaults to the list at the top of this file. */
  readonly exemptions?: ReadonlyArray<{ readonly ref: string; readonly reason: string }>
}

export interface AnalyzeResult {
  readonly problems: readonly Problem[]
  readonly fns: Map<string, ConvexFn>
  readonly refs: readonly Ref[]
  readonly sites: readonly CallSite[]
  readonly usages: number
  readonly webFacingModules: ReadonlySet<string>
}

/**
 * Pure analysis: parses everything and returns the problem list. Exported so
 * tests/unit/convex_function_refs.test.ts can drive it over synthetic fixtures
 * and assert that each failure class is actually detected.
 */
export function analyze(options: AnalyzeOptions = {}): AnalyzeResult {
  const convexDir = options.convexDir ?? CONVEX_DIR
  const refsFile = options.refsFile ?? REFS_FILE
  const webSrc = options.webSrc ?? WEB_SRC
  const exemptions = options.exemptions ?? REVERSE_COVERAGE_EXEMPTIONS

  const fns = parseConvexModules(convexDir)
  const refs = parseRefs(refsFile)
  const { sites, usages } = fs.existsSync(webSrc)
    ? parseCallSites(webSrc, refsFile)
    : { sites: [] as CallSite[], usages: 0 }

  // messages below quote the files actually under analysis
  const exemptionList = exemptions

  const problems: Problem[] = []
  const modulesOnDisk = new Set([...fns.values()].map((f) => f.module))
  const exemptRefs = new Set(exemptionList.map((e) => e.ref))

  // --- Check 1: every ref resolves ------------------------------------------
  const refByKey = new Map<string, Ref>()
  const resolved = new Map<string, ConvexFn>() // objectPath -> real fn

  for (const ref of refs) {
    const loc = `${rel(refsFile)}:${ref.line}`
    const key = `${ref.module}:${ref.name}`

    const dup = refByKey.get(key)
    if (dup !== undefined) {
      problems.push({
        title: `${ref.objectPath} — duplicate ref`,
        lines: [
          `ref:      '${ref.refString}'  (${loc})`,
          `problem:  the same convex function is already registered as ${dup.objectPath} (${rel(refsFile)}:${dup.line}).`,
          `fix:      delete one of the two entries so there is a single binding per function.`,
        ],
      })
    } else {
      refByKey.set(key, ref)
    }

    if (ref.name === '') {
      problems.push({
        title: `${ref.objectPath} — malformed ref string`,
        lines: [
          `ref:      '${ref.refString}'  (${loc})`,
          `problem:  ref is not in 'module:functionName' form.`,
          `fix:      write it as '<convex module file name>:<exported function name>'.`,
        ],
      })
      continue
    }

    const fn = fns.get(key)
    if (fn === undefined) {
      // Is the module itself wrong, or just the function name?
      if (!modulesOnDisk.has(ref.module)) {
        const elsewhere = [...fns.values()].filter((f) => f.name === ref.name)
        const hint =
          elsewhere.length > 0
            ? `Did you mean '${elsewhere[0]!.module}:${ref.name}' (${elsewhere[0]!.file}:${elsewhere[0]!.line})?`
            : `No convex/${ref.module}.ts exists. Modules on disk: ${[...modulesOnDisk].sort().join(', ')}`
        problems.push({
          title: `${ref.objectPath} — WRONG MODULE PATH`,
          lines: [
            `ref:      '${ref.refString}'  (${loc})`,
            `problem:  convex/${ref.module}.ts does not exist, so this ref can never resolve at runtime.`,
            `fix:      ${hint}`,
          ],
        })
      } else {
        const sameName = [...fns.values()].filter((f) => f.name === ref.name && f.module !== ref.module)
        const nearby = [...fns.values()]
          .filter((f) => f.module === ref.module && !f.internal && close(f.name, ref.name))
          .map((f) => f.name)
        const hint =
          sameName.length > 0
            ? `That function lives in '${sameName[0]!.module}:${ref.name}' (${sameName[0]!.file}:${sameName[0]!.line}) — fix the module half of the ref.`
            : nearby.length > 0
              ? `Closest names in convex/${ref.module}.ts: ${nearby.join(', ')}`
              : `convex/${ref.module}.ts exports no registered function named '${ref.name}'.`
        problems.push({
          title: `${ref.objectPath} — NO SUCH FUNCTION`,
          lines: [
            `ref:      '${ref.refString}'  (${loc})`,
            `problem:  convex/${ref.module}.ts has no exported query/mutation/action named '${ref.name}'.`,
            `fix:      ${hint}`,
          ],
        })
      }
      continue
    }

    resolved.set(ref.objectPath, fn)

    if (fn.internal) {
      problems.push({
        title: `${ref.objectPath} — INTERNAL FUNCTION`,
        lines: [
          `ref:      '${ref.refString}'  (${loc})`,
          `problem:  ${fn.file}:${fn.line} registers '${fn.name}' with internal${fn.kind[0]!.toUpperCase()}${fn.kind.slice(1)}(); internal functions are not callable from a client and will throw at runtime.`,
          `fix:      either make it a public ${fn.kind}() in ${fn.file}, or drop this ref and call it server-side via internal.${fn.module}.${fn.name}.`,
        ],
      })
      continue
    }

    if (fn.kind !== ref.declaredKind) {
      problems.push({
        title: `${ref.objectPath} — KIND MISMATCH (declared ${ref.declaredKind}, actually ${fn.kind})`,
        lines: [
          `ref:      makeFunctionReference${KIND_TYPEPARAM[ref.declaredKind]}('${ref.refString}')  (${loc})`,
          `problem:  ${fn.file}:${fn.line} registers '${fn.name}' as a ${fn.kind}(), not a ${ref.declaredKind}().`,
          `fix:      change the type parameter to ${KIND_TYPEPARAM[fn.kind]} and call it with ${KIND_CLIENT[fn.kind]}.`,
        ],
      })
    }
  }

  // --- Check 2: reverse coverage --------------------------------------------
  const webFacingModules = new Set(refs.filter((r) => modulesOnDisk.has(r.module)).map((r) => r.module))
  const registeredKeys = new Set(refs.map((r) => `${r.module}:${r.name}`))

  /** Clause (c): args validator reveals a non-web auth surface. */
  const otherAuthSurface = (fn: ConvexFn): string | null => {
    if (fn.args === null) return null
    if (fn.args.has('apiKeyHash')) return 'apiKeyHash (API-key-authed SDK/CLI surface)'
    if (fn.args.has('webhookSecret')) return 'webhookSecret (Clerk-webhook-authed surface)'
    return null
  }

  // Exemptions must stay live: a stale one silently mutes a future real miss.
  for (const ex of exemptionList) {
    const fn = fns.get(ex.ref)
    if (fn === undefined) {
      problems.push({
        title: `${ex.ref} — STALE REVERSE-COVERAGE EXEMPTION (function no longer exists)`,
        lines: [
          `exemption: ${rel(__filename_)} — "${ex.reason}"`,
          `problem:   no convex function '${ex.ref}' is registered any more, so this exemption mutes nothing and can hide a future miss.`,
          `fix:       delete the entry from REVERSE_COVERAGE_EXEMPTIONS in scripts/check-convex-refs.ts.`,
        ],
      })
    } else if (registeredKeys.has(ex.ref)) {
      problems.push({
        title: `${ex.ref} — STALE REVERSE-COVERAGE EXEMPTION (function is now registered)`,
        lines: [
          `exemption: ${rel(__filename_)} — "${ex.reason}"`,
          `problem:   '${ex.ref}' now has a ref in ${rel(refsFile)}, so the exemption is obsolete.`,
          `fix:       delete the entry from REVERSE_COVERAGE_EXEMPTIONS in scripts/check-convex-refs.ts.`,
        ],
      })
    }
  }

  for (const [key, fn] of fns) {
    if (fn.internal) continue
    if (!webFacingModules.has(fn.module)) continue
    if (registeredKeys.has(key)) continue
    if (exemptRefs.has(key)) continue
    if (otherAuthSurface(fn) !== null) continue
    problems.push({
      title: `${key} — MISSING REF (public ${fn.kind} in a web-facing module)`,
      lines: [
        `convex:   ${fn.file}:${fn.line}`,
        `problem:  convex/${fn.module}.ts is web-facing (other functions in it are registered in ${rel(refsFile)}) but '${fn.name}' has no ref, so the web app cannot call it.`,
        `fix:      add  ${fn.name}: makeFunctionReference${KIND_TYPEPARAM[fn.kind]}('${key}'),  under the '${fn.module}' block in ${rel(refsFile)}` +
          ` — or, if the web app must never call it, make it internal${fn.kind[0]!.toUpperCase()}${fn.kind.slice(1)}() or add it to REVERSE_COVERAGE_EXEMPTIONS in ${rel(__filename_)} with a reason.`,
      ],
    })
  }

  // --- Checks 3 & 4: call sites ---------------------------------------------
  for (const site of sites) {
    const fn = resolved.get(site.objectPath)
    if (fn === undefined) continue // unresolved refs already reported above

    if (fn.kind !== site.method) {
      problems.push({
        title: `${site.objectPath} — CALL-SITE KIND MISMATCH (called with ${site.methodText}, actually a ${fn.kind})`,
        lines: [
          `call:     ${site.file}:${site.line}`,
          `problem:  ${fn.file}:${fn.line} registers '${fn.name}' as a ${fn.kind}(); calling it via ${site.methodText}(...) throws at runtime.`,
          `fix:      use ${KIND_CLIENT[fn.kind]} at ${site.file}:${site.line}.`,
        ],
      })
    }

    if (site.argKeys !== null && fn.args !== null) {
      const unknown = [...site.argKeys].filter((k) => !fn.args!.has(k))
      const missing = [...fn.args.entries()].filter(([k, a]) => a.required && !site.argKeys!.has(k)).map(([k]) => k)
      const declared = [...fn.args.entries()].map(([k, a]) => (a.required ? k : `${k}?`)).join(', ')
      if (unknown.length > 0) {
        problems.push({
          title: `${site.objectPath} — UNKNOWN ARG${unknown.length > 1 ? 'S' : ''}: ${unknown.join(', ')}`,
          lines: [
            `call:     ${site.file}:${site.line}`,
            `problem:  the args validator at ${fn.file}:${fn.line} declares { ${declared} } — it does not accept ${unknown.join(', ')}. Convex rejects the call with ArgumentValidationError.`,
            `fix:      drop the extra arg(s) at the call site, or add them to the validator in ${fn.file}.`,
          ],
        })
      }
      if (missing.length > 0) {
        problems.push({
          title: `${site.objectPath} — MISSING REQUIRED ARG${missing.length > 1 ? 'S' : ''}: ${missing.join(', ')}`,
          lines: [
            `call:     ${site.file}:${site.line}`,
            `problem:  the args validator at ${fn.file}:${fn.line} requires { ${declared} }; this call omits ${missing.join(', ')}.`,
            `fix:      pass ${missing.join(', ')} at ${site.file}:${site.line}, or mark it v.optional() in ${fn.file}.`,
          ],
        })
      }
    }
  }

  return { problems, fns, refs, sites, usages, webFacingModules }
}

// ─── 5. CLI entry point ───────────────────────────────────────────────────────

function main(): number {
  if (!fs.existsSync(REFS_FILE)) {
    console.error(`${RED}Cannot find ${rel(REFS_FILE)}${RESET}`)
    return 1
  }

  const { problems, fns, refs, sites, usages, webFacingModules } = analyze()

  if (process.argv.includes('--list')) {
    for (const [key, fn] of [...fns.entries()].sort()) {
      const args =
        fn.args === null
          ? '(args not statically enumerable)'
          : `{ ${[...fn.args.entries()].map(([k, a]) => (a.required ? k : `${k}?`)).join(', ')} }`
      console.log(`${fn.internal ? 'internal' : 'public  '} ${fn.kind.padEnd(8)} ${key.padEnd(58)} ${args}`)
    }
    console.log(`\n${fns.size} registered convex functions, ${refs.length} refs, ${sites.length} direct call sites.`)
    return 0
  }

  const publicFns = [...fns.values()].filter((f) => !f.internal).length
  const modulesOnDisk = new Set([...fns.values()].map((f) => f.module))
  const argsChecked = sites.filter((s) => s.argKeys !== null).length
  console.log(`${BOLD}Convex function reference check${RESET}`)
  console.log(
    `${DIM}  ${fns.size} registered convex functions (${publicFns} public) in ${modulesOnDisk.size} modules` +
      `\n  ${refs.length} refs in ${rel(REFS_FILE)} — all cross-checked for module, name, kind, visibility` +
      `\n  ${sites.length}/${usages} ref usages in ${rel(WEB_SRC)} are direct call sites (kind-checked);` +
      ` ${usages - sites.length} indirect (ref passed through a variable) — not statically checkable` +
      `\n  ${argsChecked}/${sites.length} call sites pass a literal args object (args-checked)` +
      `\n  ${webFacingModules.size} web-facing modules + ${REVERSE_COVERAGE_EXEMPTIONS.length} exemptions under the reverse-coverage rule${RESET}`,
  )
  console.log('')

  if (problems.length === 0) {
    console.log(`${GREEN}✓ All convex function references resolve, kinds match, and call-site args are valid.${RESET}`)
    return 0
  }

  console.log(`${RED}${BOLD}✗ ${problems.length} problem${problems.length > 1 ? 's' : ''} found${RESET}\n`)
  for (const p of problems) {
    console.log(`${RED}✗ ${BOLD}${p.title}${RESET}`)
    for (const l of p.lines) console.log(`    ${l}`)
    console.log('')
  }
  console.log(
    `${YELLOW}These refs are string-based and are NOT checked by TypeScript (convex/_generated/api.ts is an` +
      ` \`anyApi\` stub), so every problem above is a runtime failure waiting to happen.${RESET}`,
  )
  return 1
}

// Only run the CLI when executed directly (`tsx scripts/check-convex-refs.ts`),
// so the unit test can import `analyze` without the process exiting.
const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(__filename_)
if (invokedDirectly) process.exit(main())
