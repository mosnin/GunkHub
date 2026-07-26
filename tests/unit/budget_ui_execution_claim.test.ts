/**
 * NOTHING IN THE BUDGET UI ASSERTS THAT AN AGENT STOPPED.
 *
 * ---------------------------------------------------------------------------
 * THE INVARIANT, AND WHY THE UI NEEDS ITS OWN COPY OF THE CHECK
 * ---------------------------------------------------------------------------
 *
 * There are exactly two facts this system owns and one it never does:
 *
 *   OWNED   "The breaker is tripped."   established by the server from spend it summed
 *   OWNED   "The SDK declined."         established by the SDK's own return value
 *   NEVER   "The agent halted."         a fact about a process we do not control
 *
 * Contracts makes the third unspellable in code — there is `wasDeclinedBySdk`
 * and there is deliberately no `wasAgentStopped`, because there is no honest
 * implementation of one — and the SDK gate refuses a WIRE BODY carrying any
 * field from `FORBIDDEN_ENFORCEMENT_CLAIM_FIELDS`.
 *
 * NEITHER OF THOSE COVERS PROSE ON A SCREEN. A component can narrow correctly,
 * read only sanctioned fields, and still put the word "blocked" in a heading —
 * and it is the heading, not the field name, that becomes a line in an incident
 * review and eventually a compliance claim nobody can support. So the copy gets
 * its own gate, driven by the contract's own list rather than a second one
 * invented here.
 *
 * THE LIST IS EXTENDED, NOT REPLACED. `FORBIDDEN_ENFORCEMENT_CLAIM_FIELDS` is
 * field NAMES (`agentStopped`, `wasBlocked`); prose uses the plain verbs
 * ("stopped", "was blocked"), so the prose forms are derived from it and a few
 * screen-only phrasings are added. If contracts adds a field name, this test
 * picks up its prose form automatically.
 */
import { readFileSync, readdirSync } from 'fs'
import path from 'path'

import { FORBIDDEN_ENFORCEMENT_CLAIM_FIELDS } from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'


const WEB_ROOT = path.resolve(__dirname, '../../apps/web')

const SCANNED_DIRS = [
  path.join(WEB_ROOT, 'src/components/budgets'),
  path.join(WEB_ROOT, 'src/lib/budgets'),
]

const SCANNED_FILES = [
  path.join(WEB_ROOT, 'app/(app)/settings/budgets/page.tsx'),
  path.join(WEB_ROOT, 'src/lib/services/budgets.ts'),
  path.join(WEB_ROOT, 'src/lib/services/api_v1_budgets.ts'),
  path.join(WEB_ROOT, 'app/api/v1/budgets/snapshot/route.ts'),
  path.join(WEB_ROOT, 'app/api/v1/budgets/trip/route.ts'),
  path.join(WEB_ROOT, 'app/api/v1/budgets/reset/route.ts'),
  path.join(WEB_ROOT, 'app/api/budgets/route.ts'),
  path.join(WEB_ROOT, 'app/api/budgets/[budgetId]/route.ts'),
  path.join(WEB_ROOT, 'app/api/budgets/[budgetId]/trip/route.ts'),
  path.join(WEB_ROOT, 'app/api/budgets/[budgetId]/reset/route.ts'),
]

function sources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = []
  for (const dir of SCANNED_DIRS) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue
      out.push({ file: path.join(dir, name), text: readFileSync(path.join(dir, name), 'utf8') })
    }
  }
  for (const file of SCANNED_FILES) out.push({ file, text: readFileSync(file, 'utf8') })
  return out
}

/**
 * The USER-VISIBLE strings in a source file: JSX text nodes and string
 * literals, with comments removed.
 *
 * Comments are stripped because this very file's neighbours EXPLAIN the ban by
 * naming the banned words — "there is deliberately no `wasAgentStopped`" is the
 * documentation working, not a violation. A check that could not tell the two
 * apart would force the reasoning out of the codebase, which is the opposite of
 * what it is for.
 */
function userVisibleText(text: string): string {
  const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const withoutLineComments = withoutBlockComments.replace(/^[ \t]*\/\/.*$/gm, ' ')
  return withoutLineComments
}

/**
 * The banned prose forms, derived from the contract's field-name list plus the
 * screen-only phrasings a field name would never take.
 */
function bannedProsePatterns(): { word: string; pattern: RegExp }[] {
  const fromContract = new Set<string>()
  for (const field of FORBIDDEN_ENFORCEMENT_CLAIM_FIELDS) {
    // `wasAgentStopped` -> `stopped`; `agentHalted` -> `halted`; `enforced` -> `enforced`.
    const words = field.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(' ')
    const last = words[words.length - 1]
    if (last !== undefined && last.length > 3) fromContract.add(last)
  }
  // Screen-only phrasings. A field would never be called "spend was capped",
  // but a heading might be, and that is the sentence an auditor reads.
  const screenOnly = ['spend was capped', 'spend was prevented', 'agent was stopped', 'execution stopped']

  return [
    ...[...fromContract].map((word) => ({ word, pattern: new RegExp(`\\b${word}\\b`, 'i') })),
    ...screenOnly.map((phrase) => ({ word: phrase, pattern: new RegExp(phrase, 'i') })),
  ]
}

describe('the budget UI never claims an agent stopped', () => {
  const files = sources()
  const banned = bannedProsePatterns()

  it('finds every file it claims to scan', () => {
    // 4 components + 4 lib modules in the scanned directories, plus the
    // explicitly listed files. Exact rather than a lower bound: a new budget
    // component that nobody added here would otherwise go unscanned silently.
    expect(files.length).toBe(SCANNED_FILES.length + 8)
    for (const { file, text } of files) {
      expect(text.length, `${file} is empty`).toBeGreaterThan(0)
    }
  })

  it('derives its banned list from the contract rather than restating one', () => {
    const words = banned.map((b) => b.word)
    // Sanity: the words that matter are actually in the derived list. Without
    // this, a change to the derivation could silently produce an empty list and
    // every assertion below would pass vacuously.
    for (const expected of ['stopped', 'halted', 'blocked', 'prevented', 'enforced', 'terminated']) {
      expect(words, `derivation dropped "${expected}"`).toContain(expected)
    }
  })

  it('contains no execution claim in any user-visible string', () => {
    for (const { file, text } of files) {
      const visible = userVisibleText(text)
      for (const { word, pattern } of banned) {
        expect(
          pattern.test(visible),
          `${path.relative(WEB_ROOT, file)} contains the execution claim "${word}" outside a comment`,
        ).toBe(false)
      }
    }
  })

  it('does say the two things it IS allowed to say', () => {
    // The complement. A file with no copy at all would pass the ban trivially;
    // this asserts the honest vocabulary is actually present.
    const all = files.map((f) => userVisibleText(f.text)).join('\n').toLowerCase()
    expect(all).toContain('declined')
    expect(all).toContain('tripped')
    expect(all).toContain('withhold')
  })

  it('names the SDK, not the agent, as the subject of a decline', () => {
    const vocabulary = readFileSync(path.join(WEB_ROOT, 'src/lib/budgets/vocabulary.ts'), 'utf8')
    const visible = userVisibleText(vocabulary)
    expect(visible).toContain('Declined by the SDK')
    expect(visible.toLowerCase()).not.toMatch(/agent (was |is )?(declined|halted|stopped)/)
  })
})
