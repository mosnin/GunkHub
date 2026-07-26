/**
 * Building a structured `AgentConfigSnapshot` — the SDK half of making the
 * divergence engine able to answer anything at all.
 *
 * THE PROBLEM THIS EXISTS FOR. A snapshot that is only structured when a
 * developer hand-writes it correctly will not be structured. The contract
 * (`packages/contracts/src/agent_config.ts`) defines the shape; this module is
 * what makes producing a correct one cheaper than producing a wrong one, and
 * what makes the one genuinely dangerous mistake — claiming a complete tool
 * list you did not actually enumerate — impossible to make by accident.
 *
 * WHAT THE SDK CAN CAPTURE AUTOMATICALLY, AND WHAT IT MUST ASK FOR. This is
 * the whole design question, and the honest answer is uncomfortable:
 *
 *   - AUTOMATIC, from values the caller already holds: the system prompt
 *     digest ({@link digestSystemPrompt} — hashed here, never transmitted),
 *     decoding parameters, model, budgets. These are literals in the caller's
 *     own config object; asking for them is asking them to pass what they
 *     already have.
 *
 *   - NOT AUTOMATIC, and deliberately not faked: THE TOOL LIST. The SDK never
 *     sees an agent's tool registry — it is a recording library, not a
 *     framework, and it has no hook into LangChain's, the Anthropic SDK's, or
 *     a hand-rolled dispatch table's idea of "the tools". It could infer a
 *     list from the `tool.call` events of a past run, and that inference is
 *     exactly the thing that must never happen: a list derived from what a run
 *     HAPPENED to call is a `partial` list by construction, and if it were
 *     ever recorded as `enumerated` it would manufacture `tool_removed` proofs
 *     for every tool that simply was not exercised that day. So the tool list
 *     is a required argument, with its completeness claim spelled out by the
 *     caller, and {@link toolsFromCalls} exists to make the inferred case
 *     available while forcing it to be honest — it can only ever produce
 *     `partial`.
 *
 * Nothing here reads `process.env`, touches the filesystem, or imports a
 * framework: same SDK boundary rules as the rest of the package.
 */
import { AGENT_CONFIG_SNAPSHOT_SCHEMA } from '@agent-flight-recorder/contracts'

import type {
  AgentConfigSnapshot,
  DeclaredBudgets,
  DeclaredCapabilities,
  DeclaredDecodingParams,
  DeclaredModels,
  DeclaredPrompt,
  DeclaredTool,
  DeclaredToolset,
} from '@agent-flight-recorder/contracts'

/**
 * What {@link buildAgentConfigSnapshot} accepts.
 *
 * EVERY DIMENSION IS OPTIONAL, and an omitted one is written as ABSENT rather
 * than as an empty or defaulted claim. That asymmetry is the point: a snapshot
 * that says nothing about budgets makes the engine report budgets as an
 * unanswered question, which is true, whereas a defaulted `{ declared:
 * 'unbounded' }` would be a claim the caller never made and would clear a
 * dimension nobody checked.
 */
export interface AgentConfigSnapshotInput {
  /**
   * The tool set. Build it with {@link enumeratedTools} (a complete list — the
   * only form that can support a proof), {@link partialTools}, or
   * {@link toolsFromCalls}. Omit when you cannot say.
   */
  tools?: DeclaredToolset
  /** Permitted models. `enumerated` supports proofs; a bare list of "models we happen to use" is `partial`. */
  model?: DeclaredModels
  /** Hard countable ceilings, or an explicit `{ declared: 'unbounded' }` — which is a real, checkable claim. */
  budgets?: DeclaredBudgets
  decodingParams?: DeclaredDecodingParams
  /** Prefer {@link digestSystemPrompt}; the prompt TEXT never belongs in a snapshot. */
  systemPrompt?: DeclaredPrompt
  capabilities?: DeclaredCapabilities
  /** Free-form fields your own tooling reads. Preserved verbatim, never interpreted. */
  extra?: Record<string, unknown>
}

/**
 * Build a structured `configSnapshot` to pass to version creation.
 *
 * ```ts
 * const configSnapshot = buildAgentConfigSnapshot({
 *   tools: enumeratedTools([{ name: 'search_web' }, { name: 'send_email' }]),
 *   model: { declared: 'enumerated', models: ['claude-sonnet-4-6'] },
 *   budgets: { declared: 'values', maxToolCalls: 8 },
 *   systemPrompt: await digestSystemPrompt(SYSTEM_PROMPT),
 * })
 * ```
 *
 * Declaring even ONE dimension is worth doing: coverage is per-dimension, so a
 * snapshot that declares only its tools still yields real proofs about tools
 * (and an honest unanswered question about everything else) instead of the
 * blanket `indeterminate` a free-form blob produces.
 *
 * @param input - the dimensions you can honestly declare. Omit the rest.
 * @returns a plain JSON object, safe to store as `configSnapshot` (which is
 *   `v.any()`, so this needs no backend schema change).
 */
export function buildAgentConfigSnapshot(input: AgentConfigSnapshotInput = {}): AgentConfigSnapshot {
  return {
    $schema: AGENT_CONFIG_SNAPSHOT_SCHEMA,
    ...(input.tools !== undefined && { tools: input.tools }),
    ...(input.model !== undefined && { model: input.model }),
    ...(input.budgets !== undefined && { budgets: input.budgets }),
    ...(input.decodingParams !== undefined && { decodingParams: input.decodingParams }),
    ...(input.systemPrompt !== undefined && { systemPrompt: input.systemPrompt }),
    ...(input.capabilities !== undefined && { capabilities: input.capabilities }),
    ...(input.extra !== undefined && { extra: input.extra }),
  }
}

/**
 * Declare a COMPLETE tool list — the only list form an absence can be proven
 * from.
 *
 * Say this when the array you are passing is every tool the agent can call. If
 * it is "the tools I could think of", use {@link partialTools}: a `partial`
 * list can never produce a false `tool_removed` proof, and a wrongly-claimed
 * complete one condemns a healthy version on every run that used a tool you
 * left out.
 *
 * An EMPTY complete list is a legitimate and useful claim ("this agent has no
 * tools"), and is normalised to the contract's `{ declared: 'none' }` so the
 * two spellings cannot drift apart downstream.
 */
export function enumeratedTools(tools: DeclaredTool[]): DeclaredToolset {
  if (tools.length === 0) return { declared: 'none' }
  return { declared: 'enumerated', tools }
}

/** Declare a tool list that may be incomplete. Absence from it proves nothing, by design. */
export function partialTools(tools: DeclaredTool[]): DeclaredToolset {
  return { declared: 'partial', tools }
}

/**
 * Derive a tool list from tool names actually observed in a run.
 *
 * ALWAYS `partial`, AND IT CANNOT BE MADE OTHERWISE. A run exercises the tools
 * it needed that day; the ones it did not call are missing from this list and
 * are not missing from the agent. Recording that as a complete list would
 * produce a `tool_removed` proof for every unexercised tool — a fabricated
 * certainty, which is the one outcome this whole feature is built to prevent.
 *
 * Useful as a starting point for hand-writing a real declaration; never as the
 * declaration itself.
 */
export function toolsFromCalls(observedToolNames: readonly string[]): DeclaredToolset {
  const seen: string[] = []
  for (const name of observedToolNames) {
    if (!seen.includes(name)) seen.push(name)
  }
  return { declared: 'partial', tools: seen.map((name) => ({ name })) }
}

/**
 * Hash a system prompt into a {@link DeclaredPrompt}.
 *
 * THE TEXT NEVER LEAVES. The engine only ever asks "did this change?", which a
 * digest answers exactly, and a prompt is routinely the most sensitive string
 * in an agent — putting it in a snapshot would duplicate it into a second
 * store that has to be redacted, retained and purged in its own right.
 *
 * Uses WebCrypto (`crypto.subtle`), which is present in Node 20+, browsers,
 * Deno and edge runtimes — no `node:crypto` import, so the SDK's main entry
 * stays bundler- and edge-safe.
 *
 * **Degrades honestly.** Where WebCrypto is unavailable (an old runtime, a
 * non-secure browser context) this returns `{ declared: 'unknown' }` with the
 * reason, rather than falling back to a weak non-cryptographic hash. A cheap
 * hash would collide, and a colliding prompt digest reports "prompt unchanged"
 * for a prompt that was rewritten — a false clean, produced by the SDK, on the
 * dimension operators are most likely to have changed.
 *
 * @param systemPrompt - the prompt text. Hashed locally; never stored or sent.
 */
export async function digestSystemPrompt(systemPrompt: string): Promise<DeclaredPrompt> {
  if (systemPrompt.length === 0) return { declared: 'none' }

  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
  if (subtle === undefined) {
    return {
      declared: 'unknown',
      why: 'WebCrypto (crypto.subtle) is unavailable in this runtime, so no cryptographic digest could be taken. Refusing to substitute a non-cryptographic hash: a collision would report an edited prompt as unchanged.',
    }
  }

  try {
    const bytes = new TextEncoder().encode(systemPrompt)
    const hash = await subtle.digest('SHA-256', bytes)
    const sha256 = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
    return { declared: 'digest', sha256, length: systemPrompt.length }
  } catch (err) {
    return {
      declared: 'unknown',
      why: `SHA-256 digest failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
