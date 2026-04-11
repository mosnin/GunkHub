import { auth } from '@clerk/nextjs/server'

import type {
  Comment,
  CreateCommentRequest,
  CreateCommentResponse,
} from '@agent-flight-recorder/contracts'

import { convex } from '@/lib/convexFunctions'
import { getAuthedClient } from '@/lib/convexServer'

function mapComment(doc: Record<string, unknown>): Comment {
  return {
    id: doc._id as string,
    orgId: doc.orgId as string,
    targetId: doc.targetId as string,
    targetType: doc.targetType as Comment['targetType'],
    authorId: doc.authorId as string,
    content: doc.content as string,
    createdAt: doc.createdAt as number,
    ...(doc.updatedAt !== undefined && { updatedAt: doc.updatedAt as number }),
    ...(doc.resolvedAt !== undefined && { resolvedAt: doc.resolvedAt as number }),
    ...(doc.resolvedBy !== undefined && { resolvedBy: doc.resolvedBy as string }),
  }
}

/**
 * List comments for a target (run or event).
 */
export async function listComments(
  targetId: string,
  targetType: 'run' | 'event'
): Promise<Comment[]> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) throw new Error('Not authenticated — no org context')

  const client = await getAuthedClient()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const org = await client.query(convex.organizations.getOrganization, { clerkOrgId })
  if (!org) throw new Error('Organization not found')
  const orgDoc = org as Record<string, unknown>

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const result = await client.query(convex.comments.listComments, {
    orgId: orgDoc._id,
    targetId,
    targetType,
  })
  return ((result as Record<string, unknown>[]) ?? []).map(mapComment)
}

/**
 * Resolve a comment by its ID.
 * Requires Clerk session — resolvedBy is derived from the session.
 */
export async function resolveComment(commentId: string): Promise<Comment> {
  const client = await getAuthedClient()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc = await client.mutation(convex.comments.resolveComment, { commentId })
  return mapComment(doc as Record<string, unknown>)
}

/**
 * Create a comment on a run or event.
 * Requires Clerk session — authorId is derived from the session, not the request body.
 */
export async function createComment(req: CreateCommentRequest): Promise<CreateCommentResponse> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) throw new Error('Not authenticated')

  const client = await getAuthedClient()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const org = await client.query(convex.organizations.getOrganization, { clerkOrgId })
  if (!org) throw new Error('Organization not found')

  const orgDoc = org as Record<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc = await client.mutation(convex.comments.createComment, {
    orgId: orgDoc._id,
    targetId: req.targetId,
    targetType: req.targetType,
    content: req.content,
  })

  return { comment: mapComment(doc as Record<string, unknown>) }
}
