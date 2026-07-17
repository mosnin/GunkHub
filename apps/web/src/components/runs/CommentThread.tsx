'use client'

import { useState, useTransition } from 'react'

import type { Comment } from '@agent-flight-recorder/contracts'

import { EmptyState } from '@/components/ui/EmptyState'
import { createCommentAction, resolveCommentAction } from '@/lib/actions/comments'

interface CommentThreadProps {
  targetId: string
  targetType: 'run' | 'event'
  initialComments?: Comment[]
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function CommentItem({
  comment,
  onResolve,
  resolving,
}: {
  comment: Comment
  onResolve: (id: string) => void
  resolving: boolean
}) {
  const isResolved = comment.resolvedAt !== undefined

  return (
    <div
      className={[
        'rounded-md border p-3 flex flex-col gap-2 transition-opacity duration-150',
        isResolved
          ? 'border-neutral-800 bg-neutral-950 opacity-60'
          : 'border-neutral-700 bg-neutral-900',
      ].join(' ')}
    >
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-mono text-neutral-500 truncate">
          {comment.authorId}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          {isResolved ? (
            <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-500 border border-neutral-700">
              Resolved
            </span>
          ) : (
            <button
              onClick={() => onResolve(comment.id)}
              disabled={resolving}
              className="text-xs font-medium px-2 py-0.5 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-100"
            >
              {resolving ? 'Resolving…' : 'Resolve'}
            </button>
          )}
          <span className="text-xs text-pewter">
            {formatTime(comment.createdAt)}
          </span>
        </div>
      </div>

      {/* Content */}
      <p
        className={[
          'text-sm leading-relaxed whitespace-pre-wrap break-words',
          isResolved ? 'line-through text-pewter' : 'text-neutral-300',
        ].join(' ')}
      >
        {comment.content}
      </p>

      {/* Resolved-by line */}
      {isResolved && comment.resolvedBy && comment.resolvedAt !== undefined && (
        <p className="text-xs text-pewter font-mono">
          Resolved by {comment.resolvedBy} at {formatTime(comment.resolvedAt)}
        </p>
      )}
    </div>
  )
}

export function CommentThread({
  targetId,
  targetType,
  initialComments = [],
}: CommentThreadProps) {
  const [comments, setComments] = useState<Comment[]>(initialComments)
  const [showResolved, setShowResolved] = useState(false)
  const [composeText, setComposeText] = useState('')
  const [composeError, setComposeError] = useState<string | null>(null)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [resolvingId, setResolvingId] = useState<string | null>(null)
  const [isPendingCreate, startCreateTransition] = useTransition()
  const [isPendingResolve, startResolveTransition] = useTransition()

  const unresolved = comments.filter((c) => c.resolvedAt === undefined)
  const resolved = comments.filter((c) => c.resolvedAt !== undefined)

  function handleResolve(commentId: string) {
    setResolveError(null)
    setResolvingId(commentId)

    // Optimistic update: immediately mark the comment as resolved locally
    const now = Date.now()
    setComments((prev) =>
      prev.map((c) =>
        c.id === commentId ? { ...c, resolvedAt: now } : c,
      ),
    )

    startResolveTransition(async () => {
      const result = await resolveCommentAction(commentId)
      if ('error' in result) {
        // Revert the optimistic update on failure
        setComments((prev) =>
          prev.map((c) =>
            c.id === commentId ? { ...c, resolvedAt: undefined } : c,
          ),
        )
        setResolveError(result.error)
      } else {
        // Replace the optimistic record with the real server response
        setComments((prev) =>
          prev.map((c) => (c.id === commentId ? result.comment : c)),
        )
      }
      setResolvingId(null)
    })
  }

  function handleCreate() {
    if (!composeText.trim()) return
    setComposeError(null)

    startCreateTransition(async () => {
      const result = await createCommentAction(targetId, targetType, composeText)
      if ('error' in result) {
        setComposeError(result.error)
      } else {
        setComments((prev) => [...prev, result.comment])
        setComposeText('')
      }
    })
  }

  return (
    <div className="flex flex-col gap-4 px-6 py-4">
      {/* Error banners */}
      {resolveError && (
        <div className="text-xs text-destructive-400 bg-destructive-900/40 border border-destructive-700/50 rounded px-3 py-2">
          {resolveError}
        </div>
      )}

      {/* Unresolved comments */}
      <div className="flex flex-col gap-2">
        {unresolved.length === 0 && resolved.length === 0 && (
          <EmptyState
            title="No comments yet"
            description="Be the first to add a comment on this run."
          />
        )}
        {unresolved.map((comment) => (
          <CommentItem
            key={comment.id}
            comment={comment}
            onResolve={handleResolve}
            resolving={resolvingId === comment.id && isPendingResolve}
          />
        ))}
      </div>

      {/* Resolved comments section */}
      {resolved.length > 0 && (
        <div className="flex flex-col gap-2">
          <button
            onClick={() => setShowResolved((v) => !v)}
            className="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-300 transition-colors duration-100 self-start"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              aria-hidden="true"
              className={['transition-transform duration-100', showResolved ? 'rotate-90' : ''].join(' ')}
            >
              <path d="M3 2l4 3-4 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {showResolved ? 'Hide' : 'Show'} {resolved.length} resolved
          </button>
          {showResolved &&
            resolved.map((comment) => (
              <CommentItem
                key={comment.id}
                comment={comment}
                onResolve={handleResolve}
                resolving={false}
              />
            ))}
        </div>
      )}

      {/* Compose area */}
      <div className="border border-neutral-800 rounded-md bg-neutral-900 p-3 flex flex-col gap-2">
        <textarea
          value={composeText}
          onChange={(e) => setComposeText(e.target.value)}
          placeholder="Add a comment..."
          rows={3}
          disabled={isPendingCreate}
          className="w-full bg-transparent text-sm text-neutral-300 placeholder-neutral-600 resize-none outline-none disabled:opacity-50 disabled:cursor-not-allowed"
        />
        {composeError && (
          <p className="text-xs text-destructive-400">{composeError}</p>
        )}
        <div className="flex justify-end">
          <button
            onClick={handleCreate}
            disabled={isPendingCreate || !composeText.trim()}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 hover:text-neutral-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-100"
          >
            {isPendingCreate ? 'Posting…' : 'Add comment'}
          </button>
        </div>
      </div>
    </div>
  )
}
