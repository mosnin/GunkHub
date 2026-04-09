'use client'

import { EmptyState } from '@/components/ui/EmptyState'

interface CommentThreadProps {
  targetId: string
  targetType: 'run' | 'event'
}

export function CommentThread({ targetId: _targetId, targetType: _targetType }: CommentThreadProps) {
  return (
    <div className="flex flex-col gap-4 px-6 py-4">
      {/* Comment list */}
      <div className="flex-1">
        <EmptyState title="No comments yet" description="Be the first to add a comment on this run." />
      </div>

      {/* Compose area */}
      <div className="border border-neutral-800 rounded-md bg-neutral-900 p-3 flex flex-col gap-2">
        <textarea
          disabled
          placeholder="Add a comment..."
          rows={3}
          className="w-full bg-transparent text-sm text-neutral-400 placeholder-neutral-600 resize-none outline-none disabled:cursor-not-allowed"
        />
        <div className="flex justify-end">
          <button
            disabled
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-neutral-800 text-neutral-500 cursor-not-allowed border border-neutral-700"
          >
            Add comment
          </button>
        </div>
      </div>
    </div>
  )
}
