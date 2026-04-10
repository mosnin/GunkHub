import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// A. Version string validation (inlined from actions/agent_versions.ts so
//    tests are pure and require no server imports)
// ---------------------------------------------------------------------------

/**
 * Mirrors the version-string validation logic in
 * apps/web/src/lib/actions/agent_versions.ts.
 */
function validateVersionString(v: string): string | null {
  const trimmed = v.trim()
  if (!trimmed) return 'Version is required'
  if (trimmed.length > 64) return 'Version must be 64 characters or fewer'
  return null
}

describe('validateVersionString — version string validation', () => {
  it('rejects empty string', () => {
    expect(validateVersionString('')).toBe('Version is required')
  })

  it('rejects whitespace-only string', () => {
    expect(validateVersionString('  ')).toBe('Version is required')
  })

  it('accepts a standard semver string', () => {
    expect(validateVersionString('1.0.0')).toBeNull()
  })

  it('accepts a pre-release semver string', () => {
    expect(validateVersionString('v2.3.4-beta')).toBeNull()
  })

  it('accepts a version string that is exactly 64 characters', () => {
    expect(validateVersionString('a'.repeat(64))).toBeNull()
  })

  it('rejects a version string that is 65 characters', () => {
    expect(validateVersionString('a'.repeat(65))).toBe('Version must be 64 characters or fewer')
  })

  it('trims whitespace before validation (trimmed value is valid)', () => {
    expect(validateVersionString('  1.0.0  ')).toBeNull()
  })

  it('accepts a single-character version string', () => {
    expect(validateVersionString('0')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// B. mapAgentVersion correctness (inlined from services/agent_versions.ts)
// ---------------------------------------------------------------------------

import type { AgentVersion } from '@agent-flight-recorder/contracts'

/**
 * Mirrors the mapAgentVersion() function in
 * apps/web/src/lib/services/agent_versions.ts.
 */
function mapAgentVersion(doc: Record<string, unknown>): AgentVersion {
  return {
    id: doc._id as string,
    agentId: doc.agentId as string,
    orgId: doc.orgId as string,
    version: doc.version as string,
    createdAt: doc.createdAt as number,
    ...(doc.changelog !== undefined && { changelog: doc.changelog as string }),
    ...(doc.configSnapshot !== undefined && {
      configSnapshot: doc.configSnapshot as Record<string, unknown>,
    }),
  }
}

describe('mapAgentVersion — Convex document to AgentVersion', () => {
  it('maps required fields correctly', () => {
    const doc: Record<string, unknown> = {
      _id: 'ver_abc123',
      agentId: 'agent_xyz',
      orgId: 'org_001',
      version: '1.0.0',
      createdAt: 1712500000000,
    }
    const result = mapAgentVersion(doc)
    expect(result.id).toBe('ver_abc123')
    expect(result.agentId).toBe('agent_xyz')
    expect(result.orgId).toBe('org_001')
    expect(result.version).toBe('1.0.0')
    expect(result.createdAt).toBe(1712500000000)
  })

  it('maps changelog when present in the document', () => {
    const doc: Record<string, unknown> = {
      _id: 'ver_abc123',
      agentId: 'agent_xyz',
      orgId: 'org_001',
      version: '1.0.0',
      createdAt: 1712500000000,
      changelog: 'Fixed a major bug in the routing logic.',
    }
    const result = mapAgentVersion(doc)
    expect(result.changelog).toBe('Fixed a major bug in the routing logic.')
  })

  it('omits changelog property when absent from the document', () => {
    const doc: Record<string, unknown> = {
      _id: 'ver_abc123',
      agentId: 'agent_xyz',
      orgId: 'org_001',
      version: '1.0.0',
      createdAt: 1712500000000,
    }
    const result = mapAgentVersion(doc)
    expect('changelog' in result).toBe(false)
  })

  it('maps configSnapshot when present in the document', () => {
    const snapshot = { model: 'gpt-4o', temperature: 0.7 }
    const doc: Record<string, unknown> = {
      _id: 'ver_abc123',
      agentId: 'agent_xyz',
      orgId: 'org_001',
      version: '1.0.0',
      createdAt: 1712500000000,
      configSnapshot: snapshot,
    }
    const result = mapAgentVersion(doc)
    expect(result.configSnapshot).toEqual(snapshot)
  })

  it('omits configSnapshot property when absent from the document', () => {
    const doc: Record<string, unknown> = {
      _id: 'ver_abc123',
      agentId: 'agent_xyz',
      orgId: 'org_001',
      version: '1.0.0',
      createdAt: 1712500000000,
    }
    const result = mapAgentVersion(doc)
    expect('configSnapshot' in result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// C. createAgentVersionAction validation (inlined action logic with injectable
//    service layer so tests are pure and require no server imports)
// ---------------------------------------------------------------------------

/**
 * Mirrors the createAgentVersion input shape from services/agent_versions.ts.
 */
interface CreateAgentVersionInput {
  agentId: string
  version: string
  changelog?: string
  configSnapshot?: Record<string, unknown>
}

/**
 * Mirrors createAgentVersionAction from apps/web/src/lib/actions/agent_versions.ts,
 * but with an injectable service function for testability.
 */
async function createAgentVersionActionWithService(
  agentId: string,
  version: string,
  changelog: string | undefined,
  configSnapshot: Record<string, unknown> | undefined,
  createAgentVersion: (input: CreateAgentVersionInput) => Promise<AgentVersion>,
): Promise<{ agentVersion: AgentVersion } | { error: string }> {
  if (!agentId) return { error: 'Agent ID is required' }
  const trimmed = (version ?? '').trim()
  if (!trimmed) return { error: 'Version is required' }
  if (trimmed.length > 64) return { error: 'Version must be 64 characters or fewer' }
  try {
    const agentVersion = await createAgentVersion({
      agentId,
      version: trimmed,
      ...(changelog !== undefined && changelog.trim() ? { changelog: changelog.trim() } : {}),
      ...(configSnapshot !== undefined ? { configSnapshot } : {}),
    })
    return { agentVersion }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to create agent version'
    return { error: msg }
  }
}

const baseVersion: AgentVersion = {
  id: 'ver_123',
  agentId: 'agent_abc',
  orgId: 'org_xyz',
  version: '1.0.0',
  createdAt: 1000,
}

function makeService(override?: Partial<AgentVersion>) {
  return async (_input: CreateAgentVersionInput): Promise<AgentVersion> => ({
    ...baseVersion,
    ...override,
  })
}

describe('createAgentVersionAction — action validation logic', () => {
  it('returns error when agentId is empty', async () => {
    const result = await createAgentVersionActionWithService(
      '',
      '1.0.0',
      undefined,
      undefined,
      makeService(),
    )
    expect(result).toEqual({ error: 'Agent ID is required' })
  })

  it('returns error when version is empty', async () => {
    const result = await createAgentVersionActionWithService(
      'agent_abc',
      '',
      undefined,
      undefined,
      makeService(),
    )
    expect(result).toEqual({ error: 'Version is required' })
  })

  it('returns error when version exceeds 64 characters', async () => {
    const result = await createAgentVersionActionWithService(
      'agent_abc',
      'a'.repeat(65),
      undefined,
      undefined,
      makeService(),
    )
    expect(result).toEqual({ error: 'Version must be 64 characters or fewer' })
  })

  it('calls service with correct args and returns agentVersion on valid input', async () => {
    let capturedInput: CreateAgentVersionInput | null = null
    const service = async (input: CreateAgentVersionInput): Promise<AgentVersion> => {
      capturedInput = input
      return { ...baseVersion }
    }

    const result = await createAgentVersionActionWithService(
      'agent_abc',
      '1.0.0',
      'Initial release',
      { model: 'gpt-4o' },
      service,
    )

    expect(result).toEqual({ agentVersion: baseVersion })
    expect(capturedInput).toEqual({
      agentId: 'agent_abc',
      version: '1.0.0',
      changelog: 'Initial release',
      configSnapshot: { model: 'gpt-4o' },
    })
  })

  it('returns the service error message when service throws a known Error', async () => {
    const service = async (_input: CreateAgentVersionInput): Promise<AgentVersion> => {
      throw new Error('Version "1.0.0" already exists for this agent')
    }

    const result = await createAgentVersionActionWithService(
      'agent_abc',
      '1.0.0',
      undefined,
      undefined,
      service,
    )
    expect(result).toEqual({ error: 'Version "1.0.0" already exists for this agent' })
  })

  it('returns generic error message when service throws a non-Error value', async () => {
    const service = async (_input: CreateAgentVersionInput): Promise<AgentVersion> => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'something unexpected'
    }

    const result = await createAgentVersionActionWithService(
      'agent_abc',
      '1.0.0',
      undefined,
      undefined,
      service,
    )
    expect(result).toEqual({ error: 'Failed to create agent version' })
  })
})
