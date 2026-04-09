"use client";

import { useState } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import { formatRelativeTime } from "@/lib/utils";
import type { Comment } from "@afr/contracts";

interface CommentThreadProps {
  runId: string;
  eventId?: string;
  comments: Comment[];
  onSubmit?: (content: string) => void;
}

export function CommentThread({
  runId,
  eventId,
  comments,
  onSubmit,
}: CommentThreadProps) {
  const [draft, setDraft] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = draft.trim();
    if (!content || isSubmitting) return;

    setIsSubmitting(true);
    try {
      // TODO: call API route POST /api/comments after Convex integration
      if (onSubmit) {
        onSubmit(content);
      }
      setDraft("");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Comment list */}
      {comments.length === 0 ? (
        <EmptyState
          title="No comments"
          description="Add a comment to annotate this run or specific events."
        />
      ) : (
        <div className="space-y-3">
          {comments.map((comment) => (
            <CommentCard key={comment.id} comment={comment} />
          ))}
        </div>
      )}

      {/* Compose box */}
      <form onSubmit={handleSubmit} className="space-y-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={
            eventId
              ? "Comment on this event…"
              : "Add a comment to this run…"
          }
          rows={3}
          className="w-full text-sm text-gray-700 border border-gray-200 rounded-lg px-3 py-2 placeholder-gray-400 resize-none focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
        />
        <div className="flex items-center justify-between">
          <p className="text-xs text-gray-400">
            {draft.length}/10000 chars
          </p>
          <button
            type="submit"
            disabled={!draft.trim() || isSubmitting || draft.length > 10000}
            className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400 transition-colors"
          >
            {isSubmitting ? "Posting…" : "Post comment"}
          </button>
        </div>
      </form>
    </div>
  );
}

function CommentCard({ comment }: { comment: Comment }) {
  return (
    <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-full bg-gray-300 flex items-center justify-center flex-shrink-0">
            <span className="text-xs font-medium text-gray-600">
              {comment.authorId.slice(0, 1).toUpperCase()}
            </span>
          </div>
          <span className="text-xs font-medium text-gray-700 font-mono truncate">
            {comment.authorId.slice(0, 12)}…
          </span>
        </div>
        <time className="text-xs text-gray-400 flex-shrink-0">
          {formatRelativeTime(comment.createdAt)}
        </time>
      </div>
      <p className="text-sm text-gray-700 whitespace-pre-wrap">{comment.content}</p>
      {comment.eventId && (
        <p className="text-xs text-blue-500 font-mono">
          on event: {comment.eventId.slice(0, 12)}…
        </p>
      )}
    </div>
  );
}
