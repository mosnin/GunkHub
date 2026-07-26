'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import type { Project } from '@agent-flight-recorder/contracts'

import { CreateProjectModal } from '@/components/projects/CreateProjectModal'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'

interface ProjectsListProps {
  projects: Project[]
}

export function ProjectsList({ projects }: ProjectsListProps) {
  const [showModal, setShowModal] = useState(false)
  const router = useRouter()

  function handleCreated(p: { id: string; name: string }) {
    setShowModal(false)
    router.push(`/projects/${p.id}`)
  }

  return (
    <>
      <CreateProjectModal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        onCreated={handleCreated}
      />

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold text-neutral-100">Projects</h1>
          <p className="text-sm text-neutral-500 mt-0.5">Organize your agents and runs into projects.</p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setShowModal(true)}>
          New Project
        </Button>
      </div>

      {projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Projects organize your agents and runs. Create your first project to get started."
          action={{ label: 'New Project', onClick: () => setShowModal(true) }}
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-neutral-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-800 bg-neutral-900">
                <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                  Name
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                  Slug
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                  Created
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800 bg-neutral-950">
              {projects.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => router.push(`/projects/${p.id}`)}
                  className="cursor-pointer hover:bg-neutral-900/60 transition-colors"
                >
                  <td className="px-4 py-3 text-sm text-neutral-200 font-medium">
                    {p.name}
                    {p.description && (
                      <span className="ml-2 text-xs text-pewter font-normal">{p.description}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-neutral-400">{p.slug}</td>
                  <td className="px-4 py-3 text-xs text-neutral-500">
                    {new Date(p.createdAt).toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
