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
 *   4. CALL-SITE ARGS   the args object at a call site must not pass keys the
 *                       Convex `args` validator does not declare, and must not
 *                       omit a required (non-`v.optional`) one.
 *
 * FOLLOWING INDIRECTION AND SPREADS  (added after the first cycle)
 * ----------------------------------------------------------------
 * The first version of checks 3/4 skipped anything it could not read literally:
 * refs that reached a call through a variable, and args objects containing a
 * spread. Skipping was right when the alternative was guessing, but "skipped"
 * and "checked and fine" produced the same silence, which is exactly where the
 * next bug hides. Both are now resolved rather than skipped:
 *
 *   REF INDIRECTION   a ref bound to a `const`, or chosen by a ternary, is
 *                     traced to the set of `convex.*` refs it can be. Each is
 *                     checked ON ITS OWN BRANCH, carrying that branch's
 *                     condition.
 *   SPREADS           `...base` merges when `base` is a local const object.
 *                     `...(x !== undefined && { x })` — this codebase's
 *                     dominant idiom — resolves to "key `x`, guarded by
 *                     `x !== undefined`", as does `...(c ? {a} : {b})`.
 *   CORRELATION       branch conditions and key guards are related by a tiny
 *                     conjunction algebra (see "Condition algebra" below), so
 *                     `verifyFilter !== undefined ? byVerification : listRuns`
 *                     called with `...(verifyFilter !== undefined && {…})`
 *                     is understood as one correlated whole instead of
 *                     producing two false positives.
 *   OPAQUE REMAINDER  a spread source whose keys cannot be known still gets its
 *                     EXPLICIT keys checked for unknown names (an unknown key
 *                     is rejected however it got there); only required-key
 *                     checking is impossible, and that is reported.
 *
 * Anything still unresolvable is reported as a RESIDUAL GAP with file:line, as
 * its own prominent section, on every run. "I checked and it is fine",
 * "I checked and it is broken", and "I could not check" are three distinct,
 * separately visible outcomes.
 *
 * Exits non-zero with a per-problem report naming the exact ref, its source
 * location, what is wrong, and the fix. Residual gaps and notes never affect
 * the exit code.
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

function normText(node: ts.Node, sf: ts.SourceFile): string {
  return node.getText(sf).replace(/\s+/g, ' ').trim()
}

function short(node: ts.Node, sf: ts.SourceFile, max = 72): string {
  const t = normText(node, sf)
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function unparen(e: ts.Expression): ts.Expression {
  let cur = e
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression
  return cur
}

// ─── Condition algebra ────────────────────────────────────────────────────────
//
// Both the ref indirection (`cond ? refA : refB`) and the conditional-spread
// idiom this codebase uses everywhere (`...(x !== undefined && { x })`) are
// guarded by boolean expressions. To decide whether a key is present on a given
// ref branch we need to relate those guards to one another — e.g. the branch
// that selects `listRunsByVerification` is taken exactly when
// `params.verifyFilter !== undefined`, which is precisely the guard on the
// `verifyFilter` key, so on that branch the key is DEFINITELY present; and it
// contradicts the guard on `environment`, so that key is DEFINITELY absent.
//
// The algebra is deliberately tiny and sound-by-construction: a condition is a
// CONJUNCTION of literals. A literal is either `<subject> is (not) defined`
// (from `x === undefined` / `x !== undefined` / `== null` / `!= null`) or an
// opaque atom keyed by its normalized source text. Anything the algebra cannot
// represent degrades to an opaque atom, which can neither imply nor contradict
// anything else — i.e. it degrades to "possible", never to a false claim.

interface Lit {
  readonly key: string
  readonly neg: boolean
}
type Cond = readonly Lit[]

const TRUE_COND: Cond = []

const DEFINED = '#defined'

function isNullish(n: ts.Expression): boolean {
  const u = unparen(n)
  return (ts.isIdentifier(u) && u.text === 'undefined') || u.kind === ts.SyntaxKind.NullKeyword
}

function condOf(expr: ts.Expression, sf: ts.SourceFile): Cond {
  const e = unparen(expr)
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      return [...condOf(e.left, sf), ...condOf(e.right, sf)]
    }
    const eq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken
    const ne =
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken
    if (eq || ne) {
      if (isNullish(e.right)) return [{ key: `${normText(e.left, sf)}${DEFINED}`, neg: eq }]
      if (isNullish(e.left)) return [{ key: `${normText(e.right, sf)}${DEFINED}`, neg: eq }]
    }
  }
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = negate(condOf(e.operand, sf))
    if (inner !== null) return inner
  }
  return [{ key: normText(e, sf), neg: false }]
}

function negate(c: Cond): Cond | null {
  const only = c.length === 1 ? c[0] : undefined
  return only === undefined ? null : [{ key: only.key, neg: !only.neg }]
}

/** Negation, falling back to an opaque atom when the condition is not a single literal. */
function negateOr(c: Cond, raw: string): Cond {
  return negate(c) ?? [{ key: `!(${raw})`, neg: false }]
}

function and(a: Cond, b: Cond): Cond {
  return [...a, ...b]
}

/** Does taking `branch` guarantee `guard` holds? */
function implies(branch: Cond, guard: Cond): boolean {
  return guard.every((g) => branch.some((b) => b.key === g.key && b.neg === g.neg))
}

/** Does taking `branch` guarantee `guard` does NOT hold? */
function contradicts(branch: Cond, guard: Cond): boolean {
  return guard.some((g) => branch.some((b) => b.key === g.key && b.neg !== g.neg))
}

function litText(l: Lit): string {
  if (l.key.endsWith(DEFINED)) {
    const subject = l.key.slice(0, -DEFINED.length)
    return `${subject} ${l.neg ? '===' : '!=='} undefined`
  }
  return l.neg ? `!(${l.key})` : l.key
}

function condText(c: Cond): string {
  return c.length === 0 ? 'always' : c.map(litText).join(' && ')
}

/**
 * `name -> initializer` for every `const` in a file, with `null` recorded for
 * names that are shadowed/redeclared or are not const bindings. A name absent
 * from the map is a parameter, import, or otherwise not a local const — either
 * way, not traceable, which is reported rather than assumed.
 */
function collectConsts(sf: ts.SourceFile): Map<string, ts.Expression | null> {
  const m = new Map<string, ts.Expression | null>()
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      const list = n.parent
      const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0
      const name = n.name.text
      if (m.has(name)) m.set(name, null) // redeclared/shadowed -> ambiguous
      else m.set(name, isConst && n.initializer !== undefined ? n.initializer : null)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return m
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

/** One possible ref a call site may use, with the branch condition it is used on. */
interface RefCandidate {
  readonly objectPath: string // 'convex.runs.getRun'
  readonly cond: Cond
}

/** One key of a call site's args object, with the guard it is spread under. */
interface ArgKeyInfo {
  readonly name: string
  readonly cond: Cond
  /**
   * True for the self-guarding shape `...(V !== undefined && { k: V })`, where
   * the guard tests the very value being assigned. That shape gates a key on
   * its own definedness, so when the guard is false the alternative would have
   * been passing `undefined` — which a required validator rejects identically.
   * It therefore introduces NO failure mode that omitting the guard would not
   * also have, and must not be reported as a bug. Any OTHER guard on a required
   * key does gate it, and is.
   */
  readonly selfGuard: boolean
}

/** A checked-and-fine-but-worth-saying observation. Never affects the exit code. */
export interface Note {
  readonly file: string
  readonly line: number
  readonly detail: string
}

interface ArgsShape {
  /** 'none' = no args argument at all (e.g. `useMutation(ref)`); args checks do not apply. */
  readonly kind: 'none' | 'object' | 'opaque'
  readonly keys: readonly ArgKeyInfo[]
  /** Descriptions of spread sources whose key set cannot be known. */
  readonly opaque: readonly string[]
}

interface CallSite {
  readonly file: string
  readonly line: number
  readonly candidates: readonly RefCandidate[]
  /** True when the ref reached the call through a variable rather than inline. */
  readonly indirect: boolean
  readonly method: FnKind
  readonly methodText: string // 'client.query' / 'useQuery'
  readonly args: ArgsShape
}

/** A gap the checker could not close — surfaced prominently, never silently dropped. */
export interface Residual {
  readonly kind: 'ref-indirection' | 'opaque-spread' | 'non-literal-args' | 'unenumerable-validator'
  readonly file: string
  readonly line: number
  readonly detail: string
  readonly consequence: string
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

/** Is this `convex.<a>.<b>` — an actual ref usage? */
function isConvexRefAccess(node: ts.Node): node is ts.PropertyAccessExpression {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'convex'
  )
}

/**
 * Follow a ref expression to the set of `convex.*` refs it can evaluate to,
 * recording the branch condition each is taken on.
 *
 * Resolves: an inline `convex.x.y`; a `const` bound to one (the indirection the
 * previous version of this script gave up on); a ternary between two refs (each
 * branch carries its condition, so args can be checked per branch); and any
 * nesting of those.
 *
 * Returns a failure reason for anything it CANNOT resolve — a ref chosen from a
 * function parameter, an object/array member, a call result, a reassigned `let`.
 * That reason is reported as a residual gap. "I checked and it is fine" and
 * "I could not check" must never look the same.
 */
function resolveRefExpr(
  expr: ts.Expression,
  cond: Cond,
  sf: ts.SourceFile,
  consts: Map<string, ts.Expression | null>,
  depth: number,
  out: RefCandidate[],
  consumed: Set<number>,
  failures: string[],
): void {
  const e = unparen(expr)
  if (depth > 8) {
    failures.push(`indirection nests deeper than 8 levels at \`${short(e, sf)}\``)
    return
  }
  if (isConvexRefAccess(e)) {
    consumed.add(e.getStart(sf))
    out.push({ objectPath: e.getText(sf), cond })
    return
  }
  if (ts.isConditionalExpression(e)) {
    const c = condOf(e.condition, sf)
    const raw = normText(e.condition, sf)
    resolveRefExpr(e.whenTrue, and(cond, c), sf, consts, depth + 1, out, consumed, failures)
    resolveRefExpr(e.whenFalse, and(cond, negateOr(c, raw)), sf, consts, depth + 1, out, consumed, failures)
    return
  }
  if (ts.isIdentifier(e)) {
    const init = consts.get(e.text)
    if (init === undefined) {
      failures.push(
        `\`${e.text}\` is not a local const (function parameter, import, or non-const binding) — its ref cannot be traced`,
      )
      return
    }
    if (init === null) {
      failures.push(`\`${e.text}\` is redeclared or is not a \`const\` binding — its ref cannot be traced`)
      return
    }
    resolveRefExpr(init, cond, sf, consts, depth + 1, out, consumed, failures)
    return
  }
  failures.push(`ref expression \`${short(e, sf)}\` is not a traceable \`convex.*\` reference`)
}

/** Resolve an args expression into its key set, carrying each key's guard condition. */
function resolveArgsExpr(
  expr: ts.Expression,
  cond: Cond,
  sf: ts.SourceFile,
  consts: Map<string, ts.Expression | null>,
  depth: number,
  keys: ArgKeyInfo[],
  opaque: string[],
): void {
  const e = unparen(expr)
  if (depth > 8) {
    opaque.push(`\`${short(e, sf)}\` (nested deeper than 8 levels)`)
    return
  }
  if (ts.isObjectLiteralExpression(e)) {
    for (const p of e.properties) {
      if (ts.isSpreadAssignment(p)) {
        resolveSpreadExpr(p.expression, cond, sf, consts, depth + 1, keys, opaque)
        continue
      }
      const n = propName(p)
      if (n === null) {
        opaque.push(`computed key \`${short(p, sf)}\``)
        continue
      }
      // Text of the VALUE assigned to this key, with parens/`as T`/`!` stripped,
      // so `{ endedAt: doc.endedAt as number }` self-guards against
      // `doc.endedAt !== undefined`.
      let valueText: string | null = null
      if (ts.isShorthandPropertyAssignment(p)) valueText = p.name.text
      else if (ts.isPropertyAssignment(p)) {
        let v: ts.Expression = p.initializer
        for (;;) {
          if (ts.isParenthesizedExpression(v)) v = v.expression
          else if (ts.isAsExpression(v) || ts.isTypeAssertionExpression(v)) v = v.expression
          else if (ts.isNonNullExpression(v)) v = v.expression
          else break
        }
        valueText = normText(v, sf)
      }
      const selfGuard =
        valueText !== null && cond.some((l) => !l.neg && l.key === `${valueText}${DEFINED}`)
      keys.push({ name: n, cond, selfGuard })
    }
    return
  }
  if (ts.isConditionalExpression(e)) {
    const c = condOf(e.condition, sf)
    const raw = normText(e.condition, sf)
    resolveArgsExpr(e.whenTrue, and(cond, c), sf, consts, depth + 1, keys, opaque)
    resolveArgsExpr(e.whenFalse, and(cond, negateOr(c, raw)), sf, consts, depth + 1, keys, opaque)
    return
  }
  if (ts.isIdentifier(e)) {
    const init = consts.get(e.text)
    if (init === undefined || init === null) {
      opaque.push(`\`${e.text}\` is not a traceable local const object`)
      return
    }
    resolveArgsExpr(init, cond, sf, consts, depth + 1, keys, opaque)
    return
  }
  opaque.push(`\`${short(e, sf)}\``)
}

/**
 * The spread position, where this codebase's dominant idiom lives:
 *
 *     ...(x !== undefined && { x })      -> key `x` guarded by `x !== undefined`
 *     ...(cond ? { a } : { b })          -> `a` guarded by cond, `b` by !cond
 *     ...base                            -> merged if `base` is a local const object
 *
 * A spread of `false`/`null`/`undefined` contributes nothing at runtime and is
 * treated as such rather than as an unknown.
 */
function resolveSpreadExpr(
  expr: ts.Expression,
  cond: Cond,
  sf: ts.SourceFile,
  consts: Map<string, ts.Expression | null>,
  depth: number,
  keys: ArgKeyInfo[],
  opaque: string[],
): void {
  const e = unparen(expr)
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    resolveArgsExpr(e.right, and(cond, condOf(e.left, sf)), sf, consts, depth, keys, opaque)
    return
  }
  if (
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(e) && e.text === 'undefined')
  ) {
    return
  }
  resolveArgsExpr(e, cond, sf, consts, depth, keys, opaque)
}

function parseCallSites(
  webSrc: string,
  refsFile: string,
): { sites: CallSite[]; usages: number; residuals: Residual[] } {
  const sites: CallSite[] = []
  const residuals: Residual[] = []
  let webRefUsages = 0

  for (const file of walkWebFiles(webSrc).filter((f) => f !== refsFile)) {
    const text = fs.readFileSync(file, 'utf8')
    if (!text.includes('convex.')) continue
    const sf = parseFile(file)
    const consts = collectConsts(sf)
    const usageNodes: ts.PropertyAccessExpression[] = []
    const consumed = new Set<number>()

    const visit = (node: ts.Node): void => {
      if (isConvexRefAccess(node)) {
        webRefUsages += 1
        usageNodes.push(node)
      }
      if (ts.isCallExpression(node)) {
        let method: FnKind | undefined
        let methodText = ''

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

        const refArg = node.arguments[0]
        if (method !== undefined && refArg !== undefined) {
          const candidates: RefCandidate[] = []
          const failures: string[] = []
          resolveRefExpr(refArg, TRUE_COND, sf, consts, 0, candidates, consumed, failures)

          // Only treat this as a convex call site if a `convex.*` ref was
          // actually reached; `.query()` on unrelated objects is not our business.
          if (candidates.length > 0) {
            const argsArg = node.arguments[1]
            let args: ArgsShape
            if (argsArg === undefined) {
              args = { kind: 'none', keys: [], opaque: [] }
            } else {
              const keys: ArgKeyInfo[] = []
              const opaque: string[] = []
              resolveArgsExpr(argsArg, TRUE_COND, sf, consts, 0, keys, opaque)
              const isObjectish =
                ts.isObjectLiteralExpression(unparen(argsArg)) ||
                ts.isConditionalExpression(unparen(argsArg)) ||
                keys.length > 0
              args = { kind: isObjectish ? 'object' : 'opaque', keys, opaque }
            }
            sites.push({
              file: rel(file),
              line: lineOf(node, sf),
              candidates,
              indirect: !isConvexRefAccess(unparen(refArg)),
              method,
              methodText,
              args,
            })
            for (const f of failures) {
              residuals.push({
                kind: 'ref-indirection',
                file: rel(file),
                line: lineOf(node, sf),
                detail: `${methodText}(...) — one branch of the ref resolved, another did not: ${f}`,
                consequence: 'that branch is NOT kind- or arg-checked.',
              })
            }
            if (args.kind === 'opaque') {
              residuals.push({
                kind: 'non-literal-args',
                file: rel(file),
                line: lineOf(node, sf),
                detail: `${methodText}(${candidates[0]!.objectPath}, ${short(argsArg!, sf, 48)}) — args is not an object literal`,
                consequence: 'no key can be checked at this call site.',
              })
            } else if (args.opaque.length > 0) {
              residuals.push({
                kind: 'opaque-spread',
                file: rel(file),
                line: lineOf(node, sf),
                detail: `${methodText}(${candidates[0]!.objectPath}, …) — unresolvable spread source(s): ${args.opaque.join('; ')}`,
                consequence:
                  'explicit keys ARE still checked for unknown names; required-key checking is impossible here.',
              })
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)

    // Any `convex.x.y` that no call site consumed is an indirection this script
    // could not follow. Report it with file:line rather than letting it vanish
    // into an aggregate count.
    for (const u of usageNodes) {
      if (consumed.has(u.getStart(sf))) continue
      const stmt = (():
        | ts.Node
        | undefined => {
        let cur: ts.Node | undefined = u
        while (cur !== undefined && !ts.isStatement(cur)) cur = cur.parent
        return cur
      })()
      residuals.push({
        kind: 'ref-indirection',
        file: rel(file),
        line: lineOf(u, sf),
        detail: `${u.getText(sf)} is used outside a resolvable call site${stmt === undefined ? '' : `: ${short(stmt, sf, 90)}`}`,
        consequence: 'this usage is NOT kind- or arg-checked.',
      })
    }
  }
  return { sites, usages: webRefUsages, residuals }
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
  /** Gaps the checker could not close. Not failures — but never silent. */
  readonly residuals: readonly Residual[]
  /** Checked, sound, but worth saying. Never affects the exit code. */
  readonly notes: readonly Note[]
  readonly stats: {
    /** (ref candidate, call site) pairs whose kind was checked. */
    readonly kindChecked: number
    /** Call sites where every declared key could be decided. */
    readonly fullyArgChecked: number
    /** Call sites where only unknown-key checking was possible. */
    readonly partiallyArgChecked: number
    /** Call sites where args checks do not apply (no args argument passed). */
    readonly noArgsPassed: number
  }
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
  const { sites, usages, residuals } = fs.existsSync(webSrc)
    ? parseCallSites(webSrc, refsFile)
    : { sites: [] as CallSite[], usages: 0, residuals: [] as Residual[] }

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
  //
  // A call site now has 1..n ref CANDIDATES (one per branch of a resolved
  // ternary / traced variable) and its args keys carry the guard condition they
  // are spread under. Each candidate is checked on ITS OWN branch, so the two
  // are correlated: a key whose guard the branch condition contradicts is not
  // passed on that branch, and one the branch condition implies certainly is.
  const notes: Note[] = []
  let kindChecked = 0
  let fullyArgChecked = 0
  let partiallyArgChecked = 0
  let noArgsPassed = 0

  for (const site of sites) {
    const multi = site.candidates.length > 1
    let anyArgsDecidable = false
    let anyArgsPartial = false

    for (const cand of site.candidates) {
      const fn = resolved.get(cand.objectPath)
      if (fn === undefined) continue // unresolved refs already reported above
      const branch = multi ? ` [on branch: ${condText(cand.cond)}]` : ''
      kindChecked += 1

      if (fn.kind !== site.method) {
        problems.push({
          title: `${cand.objectPath} — CALL-SITE KIND MISMATCH (called with ${site.methodText}, actually a ${fn.kind})${branch}`,
          lines: [
            `call:     ${site.file}:${site.line}${site.indirect ? '  (ref reached this call through a variable)' : ''}`,
            `problem:  ${fn.file}:${fn.line} registers '${fn.name}' as a ${fn.kind}(); calling it via ${site.methodText}(...) throws at runtime.`,
            `fix:      use ${KIND_CLIENT[fn.kind]} at ${site.file}:${site.line}.`,
          ],
        })
      }

      if (site.args.kind !== 'object' || fn.args === null) continue

      const declared = [...fn.args.entries()].map(([k, a]) => (a.required ? k : `${k}?`)).join(', ')
      const opaqueSpread = site.args.opaque.length > 0

      // Classify each key against THIS branch.
      const unknown: string[] = []
      const definite = new Set<string>()
      const possible = new Set<string>()
      for (const k of site.args.keys) {
        if (contradicts(cand.cond, k.cond)) continue // not passed on this branch
        if (implies(cand.cond, k.cond)) definite.add(k.name)
        else possible.add(k.name)
        if (!fn.args.has(k.name) && !unknown.includes(k.name)) unknown.push(k.name)
      }

      if (unknown.length > 0) {
        problems.push({
          title: `${cand.objectPath} — UNKNOWN ARG${unknown.length > 1 ? 'S' : ''}: ${unknown.join(', ')}${branch}`,
          lines: [
            `call:     ${site.file}:${site.line}`,
            `problem:  the args validator at ${fn.file}:${fn.line} declares { ${declared} } — it does not accept ${unknown.join(', ')}. Convex rejects the call with ArgumentValidationError.`,
            `fix:      drop the extra arg(s) at the call site, or add them to the validator in ${fn.file}.`,
          ],
        })
      }

      // A spread source whose keys are unknown could supply any required key,
      // so required-key checking is impossible — unknown-key checking above is
      // still sound (an unknown key is rejected however it got there).
      if (opaqueSpread) {
        anyArgsPartial = true
        continue
      }
      anyArgsDecidable = true

      const absent: string[] = []
      const conditional: { key: string; guard: string }[] = []
      for (const [k, a] of fn.args) {
        if (!a.required) continue
        if (definite.has(k)) continue
        if (possible.has(k)) {
          const src = site.args.keys.find((x) => x.name === k)
          if (src !== undefined && src.selfGuard) {
            notes.push({
              file: site.file,
              line: site.line,
              detail:
                `${cand.objectPath} passes the REQUIRED arg '${k}' under its own definedness guard ` +
                `\`${condText(src.cond)}\`. Not a defect — dropping the guard would pass \`undefined\`, which the ` +
                `validator rejects the same way — but the guard is dead weight and reads as if '${k}' were optional.`,
            })
            continue
          }
          conditional.push({ key: k, guard: src === undefined ? 'unknown' : condText(src.cond) })
        } else {
          absent.push(k)
        }
      }

      if (absent.length > 0) {
        problems.push({
          title: `${cand.objectPath} — MISSING REQUIRED ARG${absent.length > 1 ? 'S' : ''}: ${absent.join(', ')}${branch}`,
          lines: [
            `call:     ${site.file}:${site.line}`,
            `problem:  the args validator at ${fn.file}:${fn.line} requires { ${declared} }; this call omits ${absent.join(', ')}.`,
            `fix:      pass ${absent.join(', ')} at ${site.file}:${site.line}, or mark it v.optional() in ${fn.file}.`,
          ],
        })
      }

      for (const c of conditional) {
        problems.push({
          title: `${cand.objectPath} — REQUIRED ARG PASSED CONDITIONALLY: ${c.key}${branch}`,
          lines: [
            `call:     ${site.file}:${site.line}`,
            `problem:  the args validator at ${fn.file}:${fn.line} requires '${c.key}', but the call site only spreads it when \`${c.guard}\`.`,
            `          Whenever that guard is false the key is absent and Convex rejects the call with ArgumentValidationError.`,
            `fix:      pass '${c.key}' unconditionally at ${site.file}:${site.line}, or mark it v.optional() in ${fn.file}.`,
          ],
        })
      }
    }

    if (site.args.kind === 'none') noArgsPassed += 1
    else if (anyArgsDecidable) fullyArgChecked += 1
    else if (anyArgsPartial) partiallyArgChecked += 1

    // A convex function whose own `args` is not statically enumerable makes the
    // call site uncheckable from the other side. Surface that too.
    for (const cand of site.candidates) {
      const fn = resolved.get(cand.objectPath)
      if (fn !== undefined && fn.args === null && site.args.kind === 'object') {
        residuals.push({
          kind: 'unenumerable-validator',
          file: site.file,
          line: site.line,
          detail: `${cand.objectPath} — the \`args\` validator at ${fn.file}:${fn.line} is not an inline object literal`,
          consequence: 'no key of this call site can be checked against it.',
        })
      }
    }
  }

  return {
    problems,
    fns,
    refs,
    sites,
    usages,
    webFacingModules,
    residuals,
    notes,
    stats: { kindChecked, fullyArgChecked, partiallyArgChecked, noArgsPassed },
  }
}

// ─── 5. CLI entry point ───────────────────────────────────────────────────────

const RESIDUAL_HEADING: Record<Residual['kind'], string> = {
  'ref-indirection': 'UNRESOLVABLE REF INDIRECTION — which convex function is called cannot be determined',
  'opaque-spread': 'OPAQUE SPREAD SOURCE — the full key set of the args object cannot be determined',
  'non-literal-args': 'NON-LITERAL ARGS — the args argument is not an object expression',
  'unenumerable-validator': 'UNENUMERABLE VALIDATOR — the convex `args` is not an inline object literal',
}

/**
 * The residual report. This is deliberately loud and itemised: the whole point
 * of the previous cycle's "20 call sites skipped" footnote was that a gap you
 * cannot see is a gap you cannot close. Every remaining blind spot gets a
 * file:line and a statement of exactly what is NOT checked there.
 */
function printResiduals(residuals: readonly Residual[], uncheckedUsages: number): void {
  if (residuals.length === 0) {
    console.log(
      `${GREEN}✓ NO RESIDUAL GAPS${RESET} ${DIM}— every convex ref usage resolves to a call site, every args` +
        ` object is fully enumerable (conditional spreads included), and every validator is enumerable.${RESET}`,
    )
    console.log('')
    return
  }

  const byKind = new Map<Residual['kind'], Residual[]>()
  for (const r of residuals) {
    const list = byKind.get(r.kind)
    if (list === undefined) byKind.set(r.kind, [r])
    else list.push(r)
  }

  console.log(
    `${YELLOW}${BOLD}! RESIDUAL GAPS — ${residuals.length} location${residuals.length > 1 ? 's' : ''} this check` +
      ` CANNOT verify${RESET}`,
  )
  console.log(
    `${DIM}  These are not failures. They are the places where "no problem reported" means "not checked",` +
      `\n  not "checked and fine". ${uncheckedUsages} ref usage(s) never reached a checkable call site.${RESET}`,
  )
  for (const [kind, list] of byKind) {
    console.log(`\n  ${YELLOW}${RESIDUAL_HEADING[kind]}${RESET}`)
    for (const r of list) {
      console.log(`    ${BOLD}${r.file}:${r.line}${RESET}  ${r.detail}`)
      console.log(`      ${DIM}-> ${r.consequence}${RESET}`)
    }
  }
  console.log('')
}

function main(): number {
  if (!fs.existsSync(REFS_FILE)) {
    console.error(`${RED}Cannot find ${rel(REFS_FILE)}${RESET}`)
    return 1
  }

  const { problems, fns, refs, sites, usages, webFacingModules, residuals, notes, stats } = analyze()

  if (process.argv.includes('--list')) {
    for (const [key, fn] of [...fns.entries()].sort()) {
      const args =
        fn.args === null
          ? '(args not statically enumerable)'
          : `{ ${[...fn.args.entries()].map(([k, a]) => (a.required ? k : `${k}?`)).join(', ')} }`
      console.log(`${fn.internal ? 'internal' : 'public  '} ${fn.kind.padEnd(8)} ${key.padEnd(58)} ${args}`)
    }
    console.log(`\n${fns.size} registered convex functions, ${refs.length} refs, ${sites.length} call sites.`)
    return 0
  }

  const publicFns = [...fns.values()].filter((f) => !f.internal).length
  const modulesOnDisk = new Set([...fns.values()].map((f) => f.module))
  const indirectSites = sites.filter((s) => s.indirect).length
  const branchedSites = sites.filter((s) => s.candidates.length > 1).length
  const uncheckedUsages = usages - sites.reduce((n, s) => n + s.candidates.length, 0)

  console.log(`${BOLD}Convex function reference check${RESET}`)
  console.log(
    `${DIM}  ${fns.size} registered convex functions (${publicFns} public) in ${modulesOnDisk.size} modules` +
      `\n  ${refs.length} refs in ${rel(REFS_FILE)} — all cross-checked for module, name, kind, visibility` +
      `\n  ${usages} ref usages in ${rel(WEB_SRC)} -> ${sites.length} call sites, ${stats.kindChecked} kind-checked` +
      ` (${indirectSites} reached through a variable, ${branchedSites} branch over >1 ref)` +
      `\n  ${stats.fullyArgChecked} call sites fully arg-checked (unknown + required keys, conditional spreads resolved),` +
      ` ${stats.partiallyArgChecked} unknown-keys-only, ${stats.noArgsPassed} pass no args object` +
      `\n  ${webFacingModules.size} web-facing modules + ${REVERSE_COVERAGE_EXEMPTIONS.length} exemptions under the reverse-coverage rule${RESET}`,
  )
  console.log('')

  printResiduals(residuals, uncheckedUsages)

  if (notes.length > 0) {
    console.log(`${BOLD}Notes${RESET} ${DIM}(checked and sound — no action required to pass)${RESET}`)
    for (const n of notes) console.log(`  ${DIM}${n.file}:${n.line}${RESET}  ${n.detail}`)
    console.log('')
  }

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
