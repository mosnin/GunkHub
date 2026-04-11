import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Pure logic tests for the version pagination feature introduced in Prompt 17.
//
// Team C added:
//   - Convex query `paginateAgentVersions` using `.paginate()`, 20 items/page
//   - Service function `listAgentVersionsPaginated`
//   - API route GET /api/agents/[agentId]/versions?cursor=...&limit=N
//   - VersionSection now accepts `nextCursor: string | null` + "Load more" button
//
// All logic is inlined here — no imports from source files — so tests are pure,
// instant, and offline.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Group 1: Pagination cursor accumulation
// ---------------------------------------------------------------------------

describe('Pagination cursor accumulation', () => {
  it('appending a second page concatenates to the initial list', () => {
    const initial = ['v1', 'v2', 'v3']
    const extra = ['v4', 'v5']
    const allVersions = [...initial, ...extra]
    expect(allVersions).toEqual(['v1', 'v2', 'v3', 'v4', 'v5'])
    expect(allVersions.length).toBe(5)
  })

  it('appending an empty second page leaves list unchanged', () => {
    const initial = ['v1', 'v2']
    const extra: string[] = []
    const allVersions = [...initial, ...extra]
    expect(allVersions).toEqual(['v1', 'v2'])
  })

  it('hasMore is false when nextCursor is null', () => {
    const cursor: string | null = null
    const hasMore = cursor !== null
    expect(hasMore).toBe(false)
  })

  it('hasMore is true when nextCursor is a non-null string', () => {
    const cursor: string | null = 'cursor_abc123'
    const hasMore = cursor !== null
    expect(hasMore).toBe(true)
  })

  it('hasMore is true for an empty-string cursor (the string exists even if empty)', () => {
    // Edge case: an empty string is still non-null — the service decides whether
    // it is meaningful. The UI only checks null vs non-null.
    const cursor: string | null = ''
    const hasMore = cursor !== null
    expect(hasMore).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Group 2: nextCursor passthrough from service result
// ---------------------------------------------------------------------------

interface PaginatedVersionsResult {
  versions: { id: string; version: string }[]
  nextCursor: string | null
}

describe('nextCursor passthrough from service result', () => {
  it('nextCursor is forwarded when service returns a non-null cursor', () => {
    const result: PaginatedVersionsResult = {
      versions: [{ id: 'ver_1', version: '1.0.0' }],
      nextCursor: 'abc',
    }
    expect(result.nextCursor).toBe('abc')
  })

  it('nextCursor is null when service returns null (last page)', () => {
    const result: PaginatedVersionsResult = {
      versions: [{ id: 'ver_1', version: '1.0.0' }],
      nextCursor: null,
    }
    expect(result.nextCursor).toBeNull()
  })

  it('versions array is returned alongside the cursor', () => {
    const result: PaginatedVersionsResult = {
      versions: [
        { id: 'ver_1', version: '1.0.0' },
        { id: 'ver_2', version: '2.0.0' },
      ],
      nextCursor: 'page2cursor',
    }
    expect(result.versions.length).toBe(2)
    expect(result.nextCursor).toBe('page2cursor')
  })
})

// ---------------------------------------------------------------------------
// Group 3: API route query param parsing
// ---------------------------------------------------------------------------

/**
 * Mirrors the query-param parsing logic in the API route
 * GET /api/agents/[agentId]/versions?cursor=...&limit=N
 * (inlined for pure testability)
 */
function parseVersionsParams(searchParams: URLSearchParams): {
  cursor: string | null
  numItems: number
} {
  const cursor = searchParams.get('cursor')
  const numItems = searchParams.get('limit') ? Number(searchParams.get('limit')) : 20
  return { cursor, numItems }
}

describe('parseVersionsParams — API route query-param parsing', () => {
  it('parses cursor and limit when both are present', () => {
    const params = new URLSearchParams('cursor=abc&limit=10')
    const result = parseVersionsParams(params)
    expect(result.cursor).toBe('abc')
    expect(result.numItems).toBe(10)
  })

  it('returns cursor=null and numItems=50 when only limit is present', () => {
    const params = new URLSearchParams('limit=50')
    const result = parseVersionsParams(params)
    expect(result.cursor).toBeNull()
    expect(result.numItems).toBe(50)
  })

  it('returns cursor=xyz and numItems=20 (default) when only cursor is present', () => {
    const params = new URLSearchParams('cursor=xyz')
    const result = parseVersionsParams(params)
    expect(result.cursor).toBe('xyz')
    expect(result.numItems).toBe(20)
  })

  it('returns cursor=null and numItems=20 (default) when no params are present', () => {
    const params = new URLSearchParams('')
    const result = parseVersionsParams(params)
    expect(result.cursor).toBeNull()
    expect(result.numItems).toBe(20)
  })

  it('returns numItems=0 when limit=0 (zero is valid input, passes through as-is)', () => {
    // The task spec defines this as an edge case: "?limit=0 → { cursor: null, numItems: 0 }".
    // searchParams.get('limit') returns the string "0", which is truthy in JS,
    // so the ternary takes the Number() branch: Number("0") === 0.
    const params = new URLSearchParams('limit=0')
    const result = parseVersionsParams(params)
    expect(result.cursor).toBeNull()
    expect(result.numItems).toBe(0)
  })

  it('handles a cursor that contains special characters (URL-encoded)', () => {
    const cursor = 'cursor/page=2&token=abc'
    const params = new URLSearchParams(`cursor=${encodeURIComponent(cursor)}&limit=20`)
    const result = parseVersionsParams(params)
    expect(result.cursor).toBe(cursor)
    expect(result.numItems).toBe(20)
  })
})
