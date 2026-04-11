'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import type { AgentVersion } from '@agent-flight-recorder/contracts'

import { CreateVersionModal } from '@/components/agents/CreateVersionModal'
import { VersionHistory } from '@/components/agents/VersionHistory'

interface VersionSectionProps {
  agentId: string
  versions: AgentVersion[]
  nextCursor: string | null
}

export function VersionSection({ agentId, versions: initialVersions, nextCursor: initialNextCursor }: VersionSectionProps) {
  const [showModal, setShowModal] = useState(false)
  const router = useRouter()
  const [extraVersions, setExtraVersions] = useState<AgentVersion[]>([])
  const [cursor, setCursor] = useState<string | null>(initialNextCursor)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const allVersions = [...initialVersions, ...extraVersions]

  function handleLoadMore() {
    if (!cursor) return
    setLoadError(null)
    startTransition(async () => {
      try {
        const params = new URLSearchParams({ cursor, limit: '20' })
        const res = await fetch(`/api/agents/${agentId}/versions?${params.toString()}`)
        if (!res.ok) throw new Error(`Failed to load versions (${res.status})`)
        const data = (await res.json()) as { versions: AgentVersion[]; nextCursor: string | null }
        setExtraVersions((prev) => [...prev, ...data.versions])
        setCursor(data.nextCursor)
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load more versions')
      }
    })
  }

  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-neutral-300">Versions</h2>
        <button
          onClick={() => setShowModal(true)}
          className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 transition-colors"
        >
          New Version
        </button>
      </div>
      <VersionHistory versions={allVersions} />
      {(cursor !== null || loadError !== null) && (
        <div className="mt-2 flex flex-col items-start gap-1">
          {loadError && <p className="text-xs text-red-400">{loadError}</p>}
          {cursor !== null && (
            <button
              onClick={handleLoadMore}
              disabled={isPending}
              className="text-xs font-mono text-neutral-500 hover:text-neutral-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-100"
            >
              {isPending ? 'Loading\u2026' : 'Load more versions\u2026'}
            </button>
          )}
        </div>
      )}
      <CreateVersionModal
        isOpen={showModal}
        agentId={agentId}
        onClose={() => setShowModal(false)}
        onCreated={() => {
          setShowModal(false)
          router.refresh()
        }}
      />
    </>
  )
}
