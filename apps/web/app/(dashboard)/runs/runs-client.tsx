"use client";

import { RunList } from "@/components/runs/run-list";
import { useRouter } from "next/navigation";
import type { Run } from "@afr/contracts";

interface RunsClientProps {
  runs: Run[];
  isLoading?: boolean;
}

export function RunsClient({ runs, isLoading = false }: RunsClientProps) {
  const router = useRouter();

  return (
    <RunList
      runs={runs}
      isLoading={isLoading}
      onRunClick={(id) => router.push(`/runs/${id}`)}
    />
  );
}
