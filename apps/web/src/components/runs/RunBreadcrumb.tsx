import Link from 'next/link'

import { truncateId } from '@/lib/utils'

interface RunBreadcrumbProps {
  runId: string
  projectId?: string
  projectName?: string
  agentId?: string
  agentName?: string
}

export function RunBreadcrumb({ runId, projectId, projectName, agentId, agentName }: RunBreadcrumbProps) {
  return (
    <nav
      aria-label="breadcrumb"
      className="flex items-center gap-1.5 text-xs text-neutral-500 px-6 pt-4 pb-1 flex-wrap"
    >
      <Link href="/runs" className="hover:text-neutral-300 transition-colors duration-75">
        Runs
      </Link>

      {projectId && (
        <>
          <span className="text-pewter" aria-hidden>/</span>
          <Link
            href={`/projects/${projectId}`}
            className="hover:text-neutral-300 transition-colors duration-75 max-w-[180px] truncate"
            title={projectName ?? projectId}
          >
            {projectName ?? truncateId(projectId, 12)}
          </Link>
        </>
      )}

      {agentId && (
        <>
          <span className="text-pewter" aria-hidden>/</span>
          <Link
            href={`/agents/${agentId}`}
            className="hover:text-neutral-300 transition-colors duration-75 max-w-[180px] truncate"
            title={agentName ?? agentId}
          >
            {agentName ?? truncateId(agentId, 12)}
          </Link>
        </>
      )}

      <span className="text-pewter" aria-hidden>/</span>
      <span className="font-mono text-neutral-400" aria-current="page">
        {truncateId(runId, 12)}
      </span>
    </nav>
  )
}
