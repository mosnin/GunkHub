"use client";

import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonList } from "@/components/ui/loading";
import { formatBytes } from "@/lib/utils";
import type { Artifact } from "@afr/contracts";

interface ArtifactListProps {
  artifacts: Artifact[];
  isLoading: boolean;
  onDownload?: (artifact: Artifact) => void;
}

function getMimeTypeLabel(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "Image";
  if (mimeType.startsWith("text/")) return "Text";
  if (mimeType === "application/json") return "JSON";
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType.startsWith("audio/")) return "Audio";
  if (mimeType.startsWith("video/")) return "Video";
  return mimeType.split("/")[1]?.toUpperCase() ?? mimeType;
}

export function ArtifactList({
  artifacts,
  isLoading,
  onDownload,
}: ArtifactListProps) {
  if (isLoading) {
    return <SkeletonList count={2} />;
  }

  if (artifacts.length === 0) {
    return (
      <EmptyState
        title="No artifacts"
        description="Artifacts will appear here when the agent produces binary outputs."
      />
    );
  }

  return (
    <div className="space-y-2">
      {artifacts.map((artifact) => (
        <div
          key={artifact.id}
          className="flex items-start justify-between gap-3 p-3 bg-gray-50 border border-gray-200 rounded-lg"
        >
          {/* Artifact info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-xs font-medium text-gray-700 truncate font-mono">
                {artifact.storageKey.split("/").pop() ?? artifact.storageKey}
              </span>
              <span className="flex-shrink-0 px-1.5 py-0.5 text-xs text-gray-500 bg-gray-200 rounded">
                {getMimeTypeLabel(artifact.mimeType)}
              </span>
            </div>
            <div className="flex items-center gap-3 text-xs text-gray-400 font-mono">
              <span>{formatBytes(artifact.sizeBytes)}</span>
              <span title={artifact.checksum}>
                sha: {artifact.checksum.slice(0, 8)}…
              </span>
            </div>
          </div>

          {/* Download button (stub) */}
          <button
            onClick={() => onDownload?.(artifact)}
            className="flex-shrink-0 px-2.5 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded hover:bg-gray-50 transition-colors"
            title="Download artifact"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
