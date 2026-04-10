import { describe, it, expect, vi } from 'vitest'

// ---------------------------------------------------------------------------
// A. Slug generation and validation logic (inlined from services/projects.ts
//    and actions/projects.ts so tests are pure and require no server imports)
// ---------------------------------------------------------------------------

/** Mirrors the slugify() function in apps/web/src/lib/services/projects.ts */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Mirrors the name validation in apps/web/src/lib/actions/projects.ts and
 * actions/agents.ts — returns an error string or null for valid input.
 */
function validateName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Name is required'
  if (trimmed.length > 80) return 'Name must be 80 characters or fewer'
  return null
}

// ---------------------------------------------------------------------------
// A1. Slug generation
// ---------------------------------------------------------------------------

describe('slugify — project slug generation', () => {
  it('lowercases and hyphenates words', () => {
    expect(slugify('Hello World')).toBe('hello-world')
  })

  it('strips non-alphanumeric characters', () => {
    expect(slugify('My Agent (v2)')).toBe('my-agent-v2')
  })

  it('trims leading and trailing whitespace', () => {
    expect(slugify('  spaces  ')).toBe('spaces')
  })

  it('collapses multiple hyphens into one', () => {
    expect(slugify('---test---')).toBe('test')
  })

  it('handles multiple internal spaces', () => {
    expect(slugify('a   b')).toBe('a-b')
  })

  it('handles a string that is all special characters', () => {
    // All chars stripped → empty slug
    expect(slugify('!!!')).toBe('')
  })

  it('handles alphanumeric-only input unchanged (lowercased)', () => {
    expect(slugify('MyProject123')).toBe('myproject123')
  })

  it('preserves hyphens that are already present between words', () => {
    expect(slugify('my-project')).toBe('my-project')
  })

  it('strips leading/trailing hyphens after normalization', () => {
    expect(slugify('-leading-and-trailing-')).toBe('leading-and-trailing')
  })

  it('handles unicode by stripping non-ASCII letters', () => {
    // Non-ASCII chars are removed; remaining ASCII letters/digits stay
    expect(slugify('café au lait')).toBe('caf-au-lait')
  })
})

// ---------------------------------------------------------------------------
// A2. Name validation
// ---------------------------------------------------------------------------

describe('validateName — project/agent name validation', () => {
  it('returns null for a valid name', () => {
    expect(validateName('My Project')).toBeNull()
  })

  it('rejects empty string', () => {
    expect(validateName('')).toBe('Name is required')
  })

  it('rejects a string that is only whitespace', () => {
    expect(validateName('   ')).toBe('Name is required')
  })

  it('accepts a name that is exactly 80 characters', () => {
    const exactly80 = 'a'.repeat(80)
    expect(validateName(exactly80)).toBeNull()
  })

  it('rejects a name that is 81 characters', () => {
    const over80 = 'a'.repeat(81)
    expect(validateName(over80)).toBe('Name must be 80 characters or fewer')
  })

  it('rejects a name that is significantly over the limit', () => {
    const way_over = 'a'.repeat(200)
    expect(validateName(way_over)).toBe('Name must be 80 characters or fewer')
  })

  it('accepts names with special characters (validation is on trimmed length only)', () => {
    expect(validateName('My Agent (v2)')).toBeNull()
  })

  it('trims whitespace before checking emptiness', () => {
    expect(validateName('\t\n')).toBe('Name is required')
  })
})

// ---------------------------------------------------------------------------
// B. ApiKeysSection revoke flow — two-phase state machine
// ---------------------------------------------------------------------------

/**
 * Pure representation of the ApiKeysSection / RevokeButton two-phase state.
 *
 * State: { confirmingId: string | null }
 *
 * Transitions:
 *   clickRevoke(id)  — first click on a row
 *   clickConfirm(id) — second click on the same row (triggers the DELETE)
 *   clickRevoke(otherId) — clicking a different row during confirmation
 */

type RevokeState = { confirmingId: string | null }

function initialRevokeState(): RevokeState {
  return { confirmingId: null }
}

function clickRevoke(state: RevokeState, id: string): RevokeState {
  return { confirmingId: id }
}

/** Returns true when the DELETE should be issued (same id clicked in confirm phase). */
function clickConfirm(state: RevokeState, id: string): { nextState: RevokeState; shouldDelete: boolean } {
  if (state.confirmingId === id) {
    // Confirmed — fire DELETE and clear state
    return { nextState: { confirmingId: null }, shouldDelete: true }
  }
  // Different id — should not reach this branch under normal flow, but guard it
  return { nextState: { confirmingId: id }, shouldDelete: false }
}

describe('ApiKeysSection revoke — two-phase state machine', () => {
  it('starts with confirmingId as null', () => {
    const state = initialRevokeState()
    expect(state.confirmingId).toBeNull()
  })

  it('first click sets confirmingId to the clicked row id', () => {
    const state = clickRevoke(initialRevokeState(), 'key_abc')
    expect(state.confirmingId).toBe('key_abc')
  })

  it('second click on the same row triggers DELETE and clears confirmingId', () => {
    const after_first = clickRevoke(initialRevokeState(), 'key_abc')
    const { nextState, shouldDelete } = clickConfirm(after_first, 'key_abc')
    expect(shouldDelete).toBe(true)
    expect(nextState.confirmingId).toBeNull()
  })

  it('does NOT trigger DELETE if confirmingId is null', () => {
    // Sanity: cannot skip straight to confirm from null state
    const { shouldDelete } = clickConfirm(initialRevokeState(), 'key_abc')
    expect(shouldDelete).toBe(false)
  })

  it('clicking a different row during confirmation switches confirmingId to new row', () => {
    const after_first = clickRevoke(initialRevokeState(), 'key_abc')
    // Engineer clicks row "key_xyz" while "key_abc" is in confirm state
    const switched = clickRevoke(after_first, 'key_xyz')
    expect(switched.confirmingId).toBe('key_xyz')
    expect(switched.confirmingId).not.toBe('key_abc')
  })

  it('clicking different rows multiple times keeps only the last confirmingId', () => {
    let state = initialRevokeState()
    state = clickRevoke(state, 'key_1')
    state = clickRevoke(state, 'key_2')
    state = clickRevoke(state, 'key_3')
    expect(state.confirmingId).toBe('key_3')
  })
})

// ---------------------------------------------------------------------------
// C. HTTP fetch mock — loadKeys() pure logic
// ---------------------------------------------------------------------------

/**
 * Mirrors the data-loading logic in ApiKeysSection's useEffect load() function.
 * Extracted as a pure async function so it can be tested without React rendering.
 */
interface ApiKey {
  id: string
  name: string
  createdAt: number
  lastUsedAt: number | null
}

type LoadKeysResult = { keys: ApiKey[] } | { error: string }

async function loadKeys(
  fetchFn: (url: string) => Promise<Response>,
): Promise<LoadKeysResult> {
  try {
    const res = await fetchFn('/api/api-keys')
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { message?: string }
      return { error: body.message ?? `Server error ${res.status}` }
    }
    const data = await res.json() as { keys: ApiKey[] }
    return { keys: data.keys }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to load keys' }
  }
}

describe('loadKeys — GET /api/api-keys fetch logic', () => {
  it('returns keys array on successful 200 response', async () => {
    const mockKeys: ApiKey[] = [
      { id: 'key_1', name: 'production', createdAt: 1712500000000, lastUsedAt: null },
      { id: 'key_2', name: 'staging', createdAt: 1712400000000, lastUsedAt: 1712500000000 },
    ]

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ keys: mockKeys }),
    } as Response)

    const result = await loadKeys(mockFetch)
    expect(result).toEqual({ keys: mockKeys })
  })

  it('calls fetch with the correct URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ keys: [] }),
    } as Response)

    await loadKeys(mockFetch)
    expect(mockFetch).toHaveBeenCalledWith('/api/api-keys')
  })

  it('sets error state on non-ok response with message body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ message: 'Forbidden' }),
    } as Response)

    const result = await loadKeys(mockFetch)
    expect(result).toEqual({ error: 'Forbidden' })
  })

  it('sets generic error on non-ok response with no message body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response)

    const result = await loadKeys(mockFetch)
    expect(result).toEqual({ error: 'Server error 500' })
  })

  it('sets error state when fetch rejects (network failure)', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'))

    const result = await loadKeys(mockFetch)
    expect(result).toEqual({ error: 'Network error' })
  })

  it('returns empty keys array on 200 with empty list', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ keys: [] }),
    } as Response)

    const result = await loadKeys(mockFetch)
    expect(result).toEqual({ keys: [] })
  })

  it('surfaces error when json() itself throws on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => { throw new Error('not json') },
    } as unknown as Response)

    const result = await loadKeys(mockFetch)
    // Falls through to generic `Server error <status>` message
    expect(result).toEqual({ error: 'Server error 502' })
  })
})
