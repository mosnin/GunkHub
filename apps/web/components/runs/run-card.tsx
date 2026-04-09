"use client";

import { useRouter } from "next/navigation";
import { RunStatusBadge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatDuration, formatRelativeTime } from "@/lib/utils";
import type { Run } from "@afr/contracts";

interface RunCardProps {
  run: Run;
  onClick?: () => void;
}

export function RunCard({ run, onClick }: RunCardProps) {
  const router = useRouter();

  const handleClick = () => {
    if (onClick) {
      onClick();
    } else {
      router.push(`/runs/${run.id}`);
    }
  };

  return (
    <Card
      className="hover:shadow-sm transition-shadow cursor-pointer hover:border-gray-300"
      // onClick on the wrapping div handled below for accessibility
    >
      <CardContent className="p-4">
        <button
          className="w-full text-left"
          onClick={handleClick}
          type="button"
        >
          <div className="flex items-start justify-between gap-4">
            {/* Left side */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 mb-1.5">
                <RunStatusBadge status={run.status} />
                <span className="text-xs text-gray-400 font-mono truncate">
                  {run.id}
                </span>
              </div>

              {/* Error message preview */}
              {run.errorMessage && (
                <p className="text-xs text-red-600 font-mono truncate mb-1.5 bg-red-50 px-2 py-1 rounded">
                  {run.errorMessage}
                </p>
              )}

              {/* Tags */}
              {run.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-1.5">
                  {run.tags.slice(0, 5).map((tag) => (
                    <span
                      key={tag}
                      className="px-1.5 py-0.5 text-xs text-gray-500 bg-gray-100 rounded"
                    >
                      {tag}
                    </span>
                  ))}
                  {run.tags.length > 5 && (
                    <span className="text-xs text-gray-400">
                      +{run.tags.length - 5} more
                    </span>
                  )}
                </div>
              )}

              {/* Metadata row */}
              <div className="flex items-center gap-4 text-xs text-gray-400">
                <span>{formatRelativeTime(run.startedAt)}</span>
                {run.durationMs !== undefined && (
                  <span>{formatDuration(run.durationMs)}</span>
                )}
                <span className="font-mono">
                  agent: {run.agentId.slice(0, 8)}…
                </span>
              </div>
            </div>

            {/* Right side: arrow indicator */}
            <div className="flex-shrink-0 text-gray-300 mt-0.5">
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </div>
          </div>
        </button>
      </CardContent>
    </Card>
  );
}
