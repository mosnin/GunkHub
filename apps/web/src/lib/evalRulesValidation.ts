/**
 * Client-side (and server-action) validation for the JSON eval-rules editor
 * added in CreateVersionModal.tsx. Mirrors the `EvalRule` discriminated union
 * in convex/helpers/evals.ts — kept as a local copy of the *shape* rather than
 * importing that file (it lives outside apps/web's package boundary), so this
 * is deliberately duplicated and must be kept in sync if the rule shapes
 * change. This validates structure only; Convex is still the source of truth
 * and re-validates on write via convex/helpers/agent_version_fields.ts.
 */

const RULE_KINDS = [
  'terminal_status',
  'max_duration_ms',
  'max_tokens',
  'event_count',
  'payload_match',
  'no_event',
] as const

const RUN_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled', 'timed_out']
const PAYLOAD_MATCH_OPS = ['contains', 'equals', 'regex', 'not_contains']

export const MAX_EVAL_RULES = 20

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Validate a single parsed rule object against its `kind`'s expected shape. */
function validateRule(rule: unknown, index: number): string | null {
  if (!isRecord(rule)) return `Rule ${String(index + 1)} must be an object`
  const kind = rule['kind']
  if (typeof kind !== 'string' || !(RULE_KINDS as readonly string[]).includes(kind)) {
    return `Rule ${String(index + 1)}: "kind" must be one of ${RULE_KINDS.join(', ')}`
  }

  switch (kind) {
    case 'terminal_status': {
      const expect = rule['expect']
      if (!Array.isArray(expect) || expect.length === 0 || !expect.every((s) => typeof s === 'string' && RUN_STATUSES.includes(s))) {
        return `Rule ${String(index + 1)} (terminal_status): "expect" must be a non-empty array of run statuses (${RUN_STATUSES.join(', ')})`
      }
      return null
    }
    case 'max_duration_ms': {
      const limit = rule['limit']
      if (typeof limit !== 'number' || limit <= 0) {
        return `Rule ${String(index + 1)} (max_duration_ms): "limit" must be a positive number`
      }
      return null
    }
    case 'max_tokens': {
      const limitIn = rule['limitIn']
      const limitOut = rule['limitOut']
      if (limitIn === undefined && limitOut === undefined) {
        return `Rule ${String(index + 1)} (max_tokens): at least one of "limitIn" or "limitOut" is required`
      }
      if (limitIn !== undefined && (typeof limitIn !== 'number' || limitIn < 0)) {
        return `Rule ${String(index + 1)} (max_tokens): "limitIn" must be a non-negative number`
      }
      if (limitOut !== undefined && (typeof limitOut !== 'number' || limitOut < 0)) {
        return `Rule ${String(index + 1)} (max_tokens): "limitOut" must be a non-negative number`
      }
      return null
    }
    case 'event_count': {
      const min = rule['min']
      const max = rule['max']
      const eventType = rule['eventType']
      if (min === undefined && max === undefined) {
        return `Rule ${String(index + 1)} (event_count): at least one of "min" or "max" is required`
      }
      if (min !== undefined && (typeof min !== 'number' || min < 0)) {
        return `Rule ${String(index + 1)} (event_count): "min" must be a non-negative number`
      }
      if (max !== undefined && (typeof max !== 'number' || max < 0)) {
        return `Rule ${String(index + 1)} (event_count): "max" must be a non-negative number`
      }
      if (eventType !== undefined && typeof eventType !== 'string') {
        return `Rule ${String(index + 1)} (event_count): "eventType" must be a string`
      }
      return null
    }
    case 'payload_match': {
      const eventType = rule['eventType']
      const path = rule['path']
      const op = rule['op']
      const value = rule['value']
      if (typeof eventType !== 'string' || !eventType) {
        return `Rule ${String(index + 1)} (payload_match): "eventType" is required`
      }
      if (typeof path !== 'string' || !path) {
        return `Rule ${String(index + 1)} (payload_match): "path" is required`
      }
      if (typeof op !== 'string' || !PAYLOAD_MATCH_OPS.includes(op)) {
        return `Rule ${String(index + 1)} (payload_match): "op" must be one of ${PAYLOAD_MATCH_OPS.join(', ')}`
      }
      if (typeof value !== 'string') {
        return `Rule ${String(index + 1)} (payload_match): "value" must be a string`
      }
      return null
    }
    case 'no_event': {
      const eventType = rule['eventType']
      if (typeof eventType !== 'string' || !eventType) {
        return `Rule ${String(index + 1)} (no_event): "eventType" is required`
      }
      return null
    }
    default:
      return null
  }
}

export interface EvalRulesParseResult {
  rules?: Record<string, unknown>[]
  error?: string
}

/** Parse + validate the raw JSON textarea content. Empty string is valid (no rules). */
export function parseEvalRulesInput(raw: string): EvalRulesParseResult {
  const trimmed = raw.trim()
  if (!trimmed) return { rules: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { error: 'Eval rules must be valid JSON' }
  }

  if (!Array.isArray(parsed)) {
    return { error: 'Eval rules must be a JSON array of rule objects' }
  }
  if (parsed.length > MAX_EVAL_RULES) {
    return { error: `At most ${String(MAX_EVAL_RULES)} eval rules are allowed` }
  }

  for (let i = 0; i < parsed.length; i++) {
    const err = validateRule(parsed[i], i)
    if (err) return { error: err }
  }

  return { rules: parsed as Record<string, unknown>[] }
}

/** Reference text for the "rules reference" helper panel in CreateVersionModal. */
export const EVAL_RULE_REFERENCE: { kind: string; example: string; description: string }[] = [
  {
    kind: 'terminal_status',
    description: 'Passes if the run\'s final status is one of the listed statuses.',
    example: '{ "kind": "terminal_status", "expect": ["completed"] }',
  },
  {
    kind: 'max_duration_ms',
    description: 'Passes if the run finished within the given duration.',
    example: '{ "kind": "max_duration_ms", "limit": 30000 }',
  },
  {
    kind: 'max_tokens',
    description: 'Passes if token usage stayed under the given limit(s).',
    example: '{ "kind": "max_tokens", "limitIn": 5000, "limitOut": 2000 }',
  },
  {
    kind: 'event_count',
    description: 'Passes if the count of matching events is within min/max bounds.',
    example: '{ "kind": "event_count", "eventType": "tool_call", "max": 10 }',
  },
  {
    kind: 'payload_match',
    description: 'Passes if a dot-path in a matching event\'s payload satisfies the operator.',
    example: '{ "kind": "payload_match", "eventType": "tool_result", "path": "error.message", "op": "not_contains", "value": "timeout" }',
  },
  {
    kind: 'no_event',
    description: 'Passes if no event of the given type occurred during the run.',
    example: '{ "kind": "no_event", "eventType": "tool_error" }',
  },
]
