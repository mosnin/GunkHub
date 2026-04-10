'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import type { AgentVersion } from '@agent-flight-recorder/contracts'

import { CreateVersionModal } from '@/components/agents/CreateVersionModal'
import { VersionHistory } from '@/components/agents/VersionHistory'

interface VersionSectionProps {
  agentId: string
  versions: AgentVersion[]
}

export function VersionSection({ agentId, versions }: VersionSectionProps) {
  const [showModal, setShowModal] = useState(false)
  const router = useRouter()

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
      <VersionHistory versions={versions} />
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
