"use client";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import type { Event } from "@afr/contracts";

interface EventInspectorProps {
  event: Event | null;
}

type CategoryBadgeVariant = "default" | "success" | "error" | "warning" | "info" | "pending";

const categoryBadgeVariants: Record<string, CategoryBadgeVariant> = {
  lifecycle: "info",
  llm: "success",
  tool: "warning",
  memory: "default",
  retrieval: "default",
  error: "error",
  custom: "default",
};

function getBadgeVariant(category: string): CategoryBadgeVariant {
  return categoryBadgeVariants[category] ?? "default";
}

export function EventInspector({ event }: EventInspectorProps) {
  if (!event) {
    return (
      <EmptyState
        title="No event selected"
        description="Click on an event in the timeline to inspect its payload and metadata."
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Event header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant={getBadgeVariant(event.category)}>
            {event.category}
          </Badge>
          <span className="text-sm font-semibold text-gray-900">{event.type}</span>
        </div>

        {/* Metadata grid */}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
          <div className="flex gap-2">
            <dt className="text-gray-400 w-20 flex-shrink-0">Sequence</dt>
            <dd className="text-gray-700 font-mono">{event.sequence}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-gray-400 w-20 flex-shrink-0">Timestamp</dt>
            <dd className="text-gray-700 font-mono">
              {new Date(event.timestamp).toISOString()}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-gray-400 w-20 flex-shrink-0">Event ID</dt>
            <dd className="text-gray-700 font-mono truncate">{event.id}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-gray-400 w-20 flex-shrink-0">Run ID</dt>
            <dd className="text-gray-700 font-mono truncate">{event.runId}</dd>
          </div>
          {event.parentEventId && (
            <div className="flex gap-2">
              <dt className="text-gray-400 w-20 flex-shrink-0">Parent</dt>
              <dd className="text-gray-700 font-mono truncate">{event.parentEventId}</dd>
            </div>
          )}
          {event.artifactId && (
            <div className="flex gap-2">
              <dt className="text-gray-400 w-20 flex-shrink-0">Artifact</dt>
              <dd className="text-blue-600 font-mono truncate">{event.artifactId}</dd>
            </div>
          )}
        </dl>
      </div>

      {/* Payload */}
      <div>
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
          Payload
        </p>
        <div className="bg-gray-50 border border-gray-200 rounded-lg overflow-auto max-h-72">
          <pre className="p-3 text-xs text-gray-700 font-mono">
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        </div>
      </div>

      {/* Event metadata (if non-empty) */}
      {Object.keys(event.metadata).length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
            Metadata
          </p>
          <div className="bg-gray-50 border border-gray-200 rounded-lg overflow-auto max-h-40">
            <pre className="p-3 text-xs text-gray-700 font-mono">
              {JSON.stringify(event.metadata, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
