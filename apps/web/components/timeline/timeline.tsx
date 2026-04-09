"use client";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonList } from "@/components/ui/loading";
import { cn } from "@/lib/utils";
import type { Event } from "@afr/contracts";

interface TimelineProps {
  events: Event[];
  isLoading: boolean;
  onEventClick?: (event: Event) => void;
  selectedEventId?: string;
}

type CategoryColor = {
  badge: "default" | "success" | "error" | "warning" | "info" | "pending";
  dot: string;
};

const categoryColors: Record<string, CategoryColor> = {
  lifecycle: { badge: "info", dot: "bg-blue-400" },
  llm: { badge: "success", dot: "bg-green-400" },
  tool: { badge: "warning", dot: "bg-amber-400" },
  memory: { badge: "pending", dot: "bg-purple-400" },
  retrieval: { badge: "default", dot: "bg-gray-400" },
  error: { badge: "error", dot: "bg-red-500" },
  custom: { badge: "default", dot: "bg-gray-300" },
};

function getCategoryColor(category: string): CategoryColor {
  return categoryColors[category] ?? categoryColors["custom"]!;
}

function formatTimestampDelta(baseTimestamp: number, timestamp: number): string {
  const delta = timestamp - baseTimestamp;
  if (delta < 1000) return `+${delta}ms`;
  if (delta < 60000) return `+${(delta / 1000).toFixed(1)}s`;
  return `+${(delta / 60000).toFixed(1)}m`;
}

export function Timeline({
  events,
  isLoading,
  onEventClick,
  selectedEventId,
}: TimelineProps) {
  if (isLoading) {
    return <SkeletonList count={4} />;
  }

  if (events.length === 0) {
    return (
      <EmptyState
        title="No events"
        description="Events will appear here as the agent executes."
      />
    );
  }

  const sortedEvents = [...events].sort((a, b) => a.sequence - b.sequence);
  const baseTimestamp = sortedEvents[0]?.timestamp ?? 0;

  return (
    <div className="relative">
      {/* Vertical connector line */}
      <div className="absolute left-5 top-6 bottom-6 w-px bg-gray-200" />

      <div className="space-y-0">
        {sortedEvents.map((event, index) => {
          const colors = getCategoryColor(event.category);
          const isSelected = event.id === selectedEventId;
          const isLast = index === sortedEvents.length - 1;

          return (
            <div
              key={event.id}
              className={cn(
                "relative flex items-start gap-3 py-2 px-2 rounded-lg cursor-pointer transition-colors",
                isSelected
                  ? "bg-blue-50 border border-blue-200"
                  : "hover:bg-gray-50"
              )}
              onClick={() => onEventClick?.(event)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onEventClick?.(event);
              }}
            >
              {/* Sequence dot */}
              <div className="flex-shrink-0 relative z-10 mt-0.5">
                <div
                  className={cn(
                    "w-3 h-3 rounded-full border-2 border-white ring-1",
                    event.category === "error"
                      ? "ring-red-300 bg-red-500"
                      : "ring-gray-200",
                    colors.dot
                  )}
                />
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-mono text-gray-400 w-6 text-right flex-shrink-0">
                    {event.sequence}
                  </span>
                  <span className="text-sm font-medium text-gray-800 truncate">
                    {event.type}
                  </span>
                  <Badge variant={colors.badge}>{event.category}</Badge>
                </div>

                <div className="mt-0.5 flex items-center gap-3 text-xs text-gray-400 font-mono">
                  <span>
                    {formatTimestampDelta(baseTimestamp, event.timestamp)}
                  </span>
                  {event.parentEventId && (
                    <span className="truncate">
                      parent: {event.parentEventId.slice(0, 8)}…
                    </span>
                  )}
                  {event.artifactId && (
                    <span className="text-blue-500">has artifact</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
