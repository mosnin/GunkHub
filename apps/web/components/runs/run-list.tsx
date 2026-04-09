"use client";

import { SkeletonList } from "@/components/ui/loading";
import { EmptyState } from "@/components/ui/empty-state";
import { RunCard } from "./run-card";
import type { Run } from "@afr/contracts";

interface RunListProps {
  runs: Run[];
  isLoading: boolean;
  onRunClick: (id: string) => void;
}

export function RunList({ runs, isLoading, onRunClick }: RunListProps) {
  if (isLoading) {
    return <SkeletonList count={5} />;
  }

  if (runs.length === 0) {
    return (
      <EmptyState
        title="No runs found"
        description="Runs will appear here once agents start executing. Use the API to create and ingest runs."
      />
    );
  }

  return (
    <div className="space-y-2">
      {runs.map((run) => (
        <RunCard key={run.id} run={run} onClick={() => onRunClick(run.id)} />
      ))}
    </div>
  );
}
