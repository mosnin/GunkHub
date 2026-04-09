import type {
  CreateCommentRequest,
  CreateCommentResponse,
  Comment,
} from '@agent-flight-recorder/contracts'

/**
 * List comments for a target (run or event).
 * TODO: Replace with Convex query/mutation call
 */
export async function listComments(
  targetId: string,
  targetType: 'run' | 'event'
): Promise<Comment[]> {
  void targetId
  void targetType
  return []
}

/**
 * Create a new comment.
 * TODO: Replace with Convex query/mutation call
 */
export async function createComment(req: CreateCommentRequest): Promise<CreateCommentResponse> {
  return {
    comment: {
      id: `cmt_${Date.now()}`,
      orgId: '',
      targetId: req.targetId,
      targetType: req.targetType,
      authorId: '',
      content: req.content,
      createdAt: Date.now(),
    },
  }
}
