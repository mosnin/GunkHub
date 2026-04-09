import { notFound } from "next/navigation";
import { RunStatusBadge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EventInspector } from "@/components/events/event-inspector";
import { ArtifactList } from "@/components/artifacts/artifact-list";
import { CommentThread } from "@/components/comments/comment-thread";
import { formatDuration, formatRelativeTime } from "@/lib/utils";
import type { Run, Event, Artifact, Comment } from "@afr/contracts";

interface RunDetailPageProps {
  params: Promise<{ id: string }>;
}

// Stub — replace with Convex queries after npx convex dev
async function getRunById(id: string): Promise<Run | null> {
  // TODO: call Convex query to fetch run by id
  return null;
}

export default async function RunDetailPage({ params }: RunDetailPageProps) {
  const { id } = await params;
  const run = await getRunById(id);

  if (!run) {
    notFound();
  }

  // Stub data — replace with real Convex queries
  const events: Event[] = [];
  const artifacts: Artifact[] = [];
  const comments: Comment[] = [];

  return (
    <div className="p-6 space-y-6">
      {/* Run header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <RunStatusBadge status={run.status} />
            <h1 className="text-xl font-semibold text-gray-900 font-mono">{run.id}</h1>
          </div>
          <div className="flex items-center gap-4 text-xs text-gray-400">
            <span>Started {formatRelativeTime(run.startedAt)}</span>
            {run.durationMs !== undefined && (
              <span>Duration: {formatDuration(run.durationMs)}</span>
            )}
            <span>{events.length} events</span>
          </div>
        </div>
        <a
          href={`/runs/${run.id}/replay`}
          className="px-3 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors"
        >
          Replay
        </a>
      </div>

      {/* Tags */}
      {run.tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {run.tags.map((tag) => (
            <span
              key={tag}
              className="px-2 py-1 text-xs font-medium text-gray-600 bg-gray-100 rounded"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Error message */}
      {run.errorMessage && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm font-medium text-red-700 mb-1">Error</p>
          <p className="text-sm text-red-600 font-mono">{run.errorMessage}</p>
          {run.errorCode && (
            <p className="mt-1 text-xs text-red-400 font-mono">Code: {run.errorCode}</p>
          )}
        </div>
      )}

      {/* Metadata */}
      {Object.keys(run.metadata).length > 0 && (
        <Card>
          <CardHeader className="p-4">
            <CardTitle>Metadata</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <pre className="text-xs text-gray-700 font-mono bg-gray-50 p-3 rounded overflow-auto">
              {JSON.stringify(run.metadata, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}

      {/* Main content grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Events timeline — takes 2/3 width */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader className="p-4">
              <CardTitle>Events ({events.length})</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {events.length === 0 ? (
                <p className="text-sm text-gray-500">No events recorded for this run.</p>
              ) : (
                <EventInspector event={events[0] ?? null} />
              )}
            </CardContent>
          </Card>
        </div>

        {/* Sidebar — artifacts + comments */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="p-4">
              <CardTitle>Artifacts</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <ArtifactList artifacts={artifacts} isLoading={false} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="p-4">
              <CardTitle>Comments</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <CommentThread runId={run.id} comments={comments} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
