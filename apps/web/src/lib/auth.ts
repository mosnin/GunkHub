import { auth } from '@clerk/nextjs/server'
import type { AuthContext } from '@agent-flight-recorder/contracts'

/**
 * Get the current auth context from Clerk.
 * Throws if the user is not authenticated or org context is missing.
 */
export async function getCurrentAuth(): Promise<AuthContext> {
  const session = await auth()

  if (!session.userId) {
    throw new Error('Not authenticated')
  }

  if (!session.orgId) {
    throw new Error('No organization selected')
  }

  const orgRole = (session.orgRole ?? 'member') as 'admin' | 'member' | 'viewer'

  return {
    userId: session.userId,
    orgId: session.orgId,
    orgRole,
    sessionId: session.sessionId ?? '',
  }
}
