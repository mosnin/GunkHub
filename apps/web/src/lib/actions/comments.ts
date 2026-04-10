'use server'

import { auth } from '@clerk/nextjs/server'

import type { Comment } from '@agent-flight-recorder/contracts'

import { createComment, resolveComment } from '@/lib/services/comments'

/**
 * Server action: resolve a comment.
 * Returns the resolved Comment on success, or an error message string on failure.
 */
export async function resolveCommentAction(
  commentId: string,
): Promise<{ comment: Comment } | { error: string }> {
  const { orgId } = auth()
  if (!orgId) return { error: 'Not authenticated' }

  try {
    const comment = await resolveComment(commentId)
    return { comment }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to resolve comment' }
  }
}

/**
 * Server action: create a comment on a run or event.
 * Returns the created Comment on success, or an error message string on failure.
 */
export async function createCommentAction(
  targetId: string,
  targetType: 'run' | 'event',
  content: string,
): Promise<{ comment: Comment } | { error: string }> {
  const { orgId } = auth()
  if (!orgId) return { error: 'Not authenticated' }

  if (!content.trim()) return { error: 'Comment content cannot be empty' }

  try {
    const result = await createComment({ targetId, targetType, content: content.trim() })
    return { comment: result.comment }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to create comment' }
  }
}
