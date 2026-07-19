/**
 * Tests for the `scopes` field contract on `POST /api/api-keys`
 * (`resolveRequestedScopes` in apps/web/src/lib/apiKeyScopes.ts).
 *
 * This is the pure-logic tier of the read-key-issuance seam closed in
 * Cycle 3 — deliberately dependency-free (no `next/server`, no Clerk, no
 * Convex client) so it is testable here without a Next.js runtime or a live
 * Convex deployment, same rationale as apiAuthGuard.ts's hasOrgAuthContext
 * (see tests/unit/management_route_auth.test.ts). The data-plane tier (does
 * a key minted with `["read"]` actually work against `/api/v1/**`, and does
 * an ingest-only key actually get rejected there?) is exercised end-to-end
 * against real Convex functions in convex/e2e_cohesion.test.ts — see that
 * file's header comment for why it lives under convex/ (edge-runtime
 * convex-test harness) rather than here.
 */
import { describe, expect, it } from 'vitest'

import {
  ALLOWED_KEY_SCOPES,
  DEFAULT_KEY_SCOPES,
  resolveRequestedScopes,
} from '../../apps/web/src/lib/apiKeyScopes.js'

describe('resolveRequestedScopes — POST /api/api-keys scopes contract', () => {
  it('defaults to ["ingest:write"] when scopes is omitted (preserves pre-existing ingest-key behavior)', () => {
    const result = resolveRequestedScopes(undefined)
    expect(result).toEqual({ ok: true, scopes: ['ingest:write'] })
    expect(result).toEqual({ ok: true, scopes: [...DEFAULT_KEY_SCOPES] })
  })

  it('accepts a request for a dedicated read-only key', () => {
    const result = resolveRequestedScopes(['read'])
    expect(result).toEqual({ ok: true, scopes: ['read'] })
  })

  it('accepts a key with multiple scopes, e.g. ingest:write + read', () => {
    const result = resolveRequestedScopes(['ingest:write', 'read'])
    expect(result).toEqual({ ok: true, scopes: ['ingest:write', 'read'] })
  })

  it('accepts every individually allowed scope', () => {
    for (const scope of ALLOWED_KEY_SCOPES) {
      expect(resolveRequestedScopes([scope])).toEqual({ ok: true, scopes: [scope] })
    }
  })

  it('rejects an unknown scope name', () => {
    const result = resolveRequestedScopes(['delete-everything'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('delete-everything')
  })

  it('rejects a mix of a valid and an unknown scope, naming only the unknown one', () => {
    const result = resolveRequestedScopes(['read', 'bogus'])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('bogus')
      expect(result.error).not.toContain('"read"')
    }
  })

  it('rejects a non-array value', () => {
    expect(resolveRequestedScopes('read').ok).toBe(false)
    expect(resolveRequestedScopes({ scope: 'read' }).ok).toBe(false)
    expect(resolveRequestedScopes(42).ok).toBe(false)
  })

  it('rejects an empty array rather than silently defaulting', () => {
    const result = resolveRequestedScopes([])
    expect(result.ok).toBe(false)
  })

  it('rejects non-string entries in an otherwise well-formed array', () => {
    const result = resolveRequestedScopes(['read', 123])
    expect(result.ok).toBe(false)
  })
})
