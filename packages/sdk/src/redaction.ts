import type { EventPayload, EventType } from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// Redaction pipeline
//
// Applied by BOTH recorder paths (`Recorder.recordEvent` and
// `RunRecorder.recordEvent`) BEFORE the payload is buffered/spooled/sent, and
// therefore before `externalizePayloadIfLarge` measures its size — a payload
// that shrinks below the 10 KB externalization threshold once secrets are
// stripped is shipped inline, not as an artifact pointer. "Redact-then-measure"
// is the whole point: externalizing an unredacted blob would just move the
// leak into blob storage instead of preventing it.
// ---------------------------------------------------------------------------

/** Keys that must never be traversed into — writing through them can pollute Object.prototype. */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Hard bounds so a hostile/pathological payload cannot DoS the redaction walk. */
const MAX_DEPTH = 32
const MAX_NODES = 10_000

/**
 * A single named built-in pattern, or a caller-supplied `RegExp` for anything
 * not covered by the built-ins.
 *
 * False-positive tradeoffs (documented here since these are "best effort,
 * not exhaustive" — treat redaction as defense in depth, not a guarantee):
 * - `'email'` — matches most real addresses; can over-match inside
 *   already-obfuscated text (e.g. `user (at) example.com` is NOT matched —
 *   under-matching is the more common failure mode for obfuscated emails).
 * - `'api_key'` — only matches well-known vendor prefixes (`sk_`, `pk_`,
 *   `AKIA...`, `gh[pousr]_...`, `AIza...`, `xox[baprs]-...`). A bespoke or
 *   unprefixed secret (e.g. a raw 32-char hex token) will NOT be caught —
 *   pair with `paths` for known secret fields.
 * - `'jwt'` — matches the three-segment `eyJ....eyJ.......` shape. Any
 *   base64url blob that happens to start with two JSON-header-shaped
 *   segments could false-positive; genuinely rare in practice.
 * - `'credit_card'` — candidate 13-19 digit runs are additionally verified
 *   with a Luhn checksum before redaction, which eliminates the vast
 *   majority of false positives (phone numbers, order IDs, timestamps) at
 *   the cost of missing card numbers that happen to fail Luhn validation
 *   (which is to say: are not valid card numbers in the first place).
 * - `'ssn'` — matches the `###-##-####` shape only. A 9-digit SSN with no
 *   dashes is NOT matched (too many legitimate 9-digit numbers to safely
 *   redact without dashes as a signal).
 * - `'phone'` — matches common US/NANP formats. Under `credit_card`-adjacent
 *   digit runs it can double-match; harmless since both replace with the
 *   same placeholder.
 */
export type RedactionPattern = RegExp | 'email' | 'api_key' | 'jwt' | 'credit_card' | 'ssn' | 'phone'

export interface RedactionConfig {
  /**
   * Dot-paths into the event payload, with `*` matching any array index or
   * object key at that segment (e.g. `'messages.*.content'` redacts every
   * message's `content` field). Traversal is bounded (see {@link MAX_NODES})
   * and refuses to descend through `__proto__`/`constructor`/`prototype`.
   */
  paths?: string[]
  /** Built-in named patterns and/or caller-supplied regexes, applied to every string leaf. */
  patterns?: RedactionPattern[]
  /** Replacement text for anything matched. Default: `'[REDACTED]'`. */
  replacement?: string
  /**
   * Arbitrary transform applied AFTER `paths`/`patterns` have already run.
   * Receives the (already partially redacted) payload. If it throws, the
   * built-in `paths`/`patterns` output (which already ran) is used as-is, a
   * `_redactionDegraded: true` marker is set on the returned payload, and
   * `onRedactionError` fires — the payload is NEVER passed through
   * unredacted on a `custom` failure.
   */
  custom?: (payload: EventPayload, eventType: EventType) => EventPayload
}

/** Payload shape after redaction, which may carry the degraded-fallback marker. */
export type RedactedPayload = EventPayload & { _redactionDegraded?: true }

function safeKeys(obj: object): string[] {
  return Object.keys(obj).filter((k) => !DANGEROUS_KEYS.has(k))
}

// ---------------------------------------------------------------------------
// Bounded deep clone — never mutate the caller's object.
// ---------------------------------------------------------------------------

function deepCloneBounded(value: unknown): unknown {
  const budget = { nodes: 0 }
  const clone = (v: unknown, depth: number): unknown => {
    budget.nodes++
    if (budget.nodes > MAX_NODES || depth > MAX_DEPTH) {
      // Bail out of further structural cloning for this subtree. Primitives
      // pass through as-is; objects/arrays are cut off (returned as a shallow
      // reference) rather than risking unbounded recursion or copy cost.
      return v
    }
    if (Array.isArray(v)) {
      return v.map((item) => clone(item, depth + 1))
    }
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const key of safeKeys(v)) {
        out[key] = clone((v as Record<string, unknown>)[key], depth + 1)
      }
      return out
    }
    return v
  }
  return clone(value, 0)
}

// ---------------------------------------------------------------------------
// Path-based redaction (wildcard dot-paths)
// ---------------------------------------------------------------------------

function applyPathRedaction(
  root: unknown,
  segments: string[],
  replacement: string,
  budget: { nodes: number }
): void {
  if (segments.length === 0 || root === null || typeof root !== 'object') return
  if (budget.nodes > MAX_NODES) return

  const [head, ...rest] = segments
  if (head === undefined) return

  if (head === '*') {
    const keys = Array.isArray(root) ? root.map((_, i) => String(i)) : safeKeys(root)
    for (const key of keys) {
      budget.nodes++
      if (budget.nodes > MAX_NODES) return
      const container = root as Record<string, unknown>
      if (rest.length === 0) {
        container[key] = replacement
      } else {
        applyPathRedaction(container[key], rest, replacement, budget)
      }
    }
    return
  }

  if (DANGEROUS_KEYS.has(head)) return
  const container = root as Record<string, unknown>
  if (!(head in container)) return
  budget.nodes++
  if (rest.length === 0) {
    container[head] = replacement
  } else {
    applyPathRedaction(container[head], rest, replacement, budget)
  }
}

// ---------------------------------------------------------------------------
// Pattern-based redaction (string content scan)
// ---------------------------------------------------------------------------

interface CompiledPattern {
  name: string
  regex: RegExp
  /** Optional post-match validator (used by `credit_card`'s Luhn check). */
  validate?: (match: string) => boolean
}

function luhnCheck(candidate: string): boolean {
  const digits = candidate.replace(/[ -]/g, '')
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let alternate = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i])
    if (alternate) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alternate = !alternate
  }
  return sum % 10 === 0
}

const BUILTIN_REGEX: Record<Exclude<RedactionPattern, RegExp>, () => RegExp> = {
  email: () => /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  api_key: () =>
    /\b(?:sk|pk|rk)_[A-Za-z0-9_]{16,}\b|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bAIza[0-9A-Za-z_-]{35}\b|\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
  jwt: () => /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  credit_card: () => /\b(?:\d[ -]?){13,19}\b/g,
  ssn: () => /\b\d{3}-\d{2}-\d{4}\b/g,
  phone: () => /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
}

function compilePatterns(patterns: RedactionPattern[]): CompiledPattern[] {
  return patterns.map((p, i) => {
    if (p instanceof RegExp) {
      const flags = p.flags.includes('g') ? p.flags : `${p.flags}g`
      return { name: `custom_regex_${i}`, regex: new RegExp(p.source, flags) }
    }
    const build = BUILTIN_REGEX[p]
    if (!build) {
      throw new Error(`Unknown redaction pattern: "${String(p)}"`)
    }
    return {
      name: p,
      regex: build(),
      ...(p === 'credit_card' && { validate: luhnCheck }),
    }
  })
}

function redactString(value: string, patterns: CompiledPattern[], replacement: string): string {
  let result = value
  for (const pattern of patterns) {
    result = result.replace(pattern.regex, (match) => {
      if (pattern.validate && !pattern.validate(match)) return match
      return replacement
    })
  }
  return result
}

function walkAndRedactStrings(
  node: unknown,
  patterns: CompiledPattern[],
  replacement: string,
  budget: { nodes: number },
  depth: number
): unknown {
  budget.nodes++
  if (budget.nodes > MAX_NODES || depth > MAX_DEPTH) return node
  if (typeof node === 'string') return redactString(node, patterns, replacement)
  if (Array.isArray(node)) {
    return node.map((item) => walkAndRedactStrings(item, patterns, replacement, budget, depth + 1))
  }
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of safeKeys(node)) {
      out[key] = walkAndRedactStrings((node as Record<string, unknown>)[key], patterns, replacement, budget, depth + 1)
    }
    return out
  }
  return node
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Redact an event payload before it is buffered, spooled, or sent.
 *
 * Order of operations: deep-clone (never mutates the caller's object) →
 * `paths` (exact field targeting) → `patterns` (content scan) → `custom`
 * (caller transform, applied last so it can see the already-redacted shape).
 * `paths` and `patterns` always run — this is what guarantees a `custom`
 * throw still returns redacted (not raw) data.
 *
 * @param payload - the original event payload (never mutated)
 * @param eventType - the event's type, passed through to `custom`
 * @param config - redaction rules
 * @param onRedactionError - called (never throws into the caller) when
 *   `patterns` contains an invalid entry or `custom` throws
 * @returns a new payload with redaction applied; carries `_redactionDegraded:
 *   true` if `custom` threw
 */
export function redactPayload(
  payload: EventPayload,
  eventType: EventType,
  config: RedactionConfig,
  onRedactionError?: (error: string) => void
): RedactedPayload {
  const replacement = config.replacement ?? '[REDACTED]'
  const notify = (message: string): void => {
    try {
      onRedactionError?.(message)
    } catch {
      // Consumer callback must never crash the recorder.
    }
  }

  let working = deepCloneBounded(payload) as Record<string, unknown>

  if (config.paths && config.paths.length > 0) {
    const budget = { nodes: 0 }
    for (const path of config.paths) {
      const segments = path.split('.').filter((s) => s.length > 0)
      if (segments.length === 0) continue
      applyPathRedaction(working, segments, replacement, budget)
    }
  }

  if (config.patterns && config.patterns.length > 0) {
    let compiled: CompiledPattern[] = []
    try {
      compiled = compilePatterns(config.patterns)
    } catch (err) {
      notify(`Invalid redaction pattern config: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (compiled.length > 0) {
      working = walkAndRedactStrings(working, compiled, replacement, { nodes: 0 }, 0) as Record<string, unknown>
    }
  }

  if (config.custom) {
    const preCustom = working
    try {
      const result = config.custom(preCustom as unknown as EventPayload, eventType)
      return result as unknown as RedactedPayload
    } catch (err) {
      notify(`custom redaction function threw: ${err instanceof Error ? err.message : String(err)}`)
      return { ...preCustom, _redactionDegraded: true } as unknown as RedactedPayload
    }
  }

  return working as unknown as RedactedPayload
}
