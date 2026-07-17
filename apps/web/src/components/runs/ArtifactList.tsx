'use client'

import { useRef, useState } from 'react'

import type { Artifact } from '@agent-flight-recorder/contracts'

import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingState } from '@/components/ui/LoadingState'

interface ArtifactListProps {
  artifacts: Artifact[]
  loading?: boolean
}

interface DownloadState {
  downloading: boolean
  error: string | null
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function extractFilename(
  contentDisposition: string | null,
  artifact: Artifact,
): string {
  if (contentDisposition) {
    // RFC 5987 encoded filename* takes priority
    const rfc5987Match = contentDisposition.match(
      /filename\*=(?:UTF-8'')?([^;]+)/i,
    )
    if (rfc5987Match?.[1]) {
      try {
        return decodeURIComponent(rfc5987Match[1].trim())
      } catch {
        // fall through
      }
    }
    // Plain filename= fallback
    const plainMatch = contentDisposition.match(
      /filename="?([^";\r\n]+)"?/i,
    )
    if (plainMatch?.[1]) {
      return plainMatch[1].trim()
    }
  }
  return artifact.name ?? artifact.id
}

export function ArtifactList({ artifacts, loading }: ArtifactListProps) {
  const [downloadStates, setDownloadStates] = useState<
    Record<string, DownloadState>
  >({})

  // Hidden anchor used to trigger programmatic downloads
  const hiddenAnchorRef = useRef<HTMLAnchorElement>(null)

  if (loading) {
    return <LoadingState message="Loading artifacts..." />
  }

  if (artifacts.length === 0) {
    return (
      <div className="p-6">
        <EmptyState title="No artifacts recorded for this run." />
      </div>
    )
  }

  function setStateForId(id: string, patch: Partial<DownloadState>) {
    setDownloadStates((prev) => ({
      ...prev,
      [id]: { downloading: false, error: null, ...prev[id], ...patch },
    }))
  }

  async function handleDownload(artifact: Artifact) {
    const id = artifact.id

    // Clear any previous error and mark downloading
    setDownloadStates((prev) => ({
      ...prev,
      [id]: { downloading: true, error: null },
    }))

    let response: Response
    try {
      response = await fetch(`/api/artifacts/${id}/download`)
    } catch (networkErr) {
      setStateForId(id, {
        downloading: false,
        error: networkErr instanceof Error ? networkErr.message : 'Network error',
      })
      return
    }

    if (!response.ok) {
      let message = `Download failed (HTTP ${response.status})`
      try {
        const err = (await response.json()) as { code: string; message: string }
        if (err.message) message = err.message
      } catch {
        // JSON parse failed; keep the generic message
      }
      setStateForId(id, { downloading: false, error: message })
      return
    }

    let blob: Blob
    try {
      blob = await response.blob()
    } catch {
      setStateForId(id, {
        downloading: false,
        error: 'Failed to read download response.',
      })
      return
    }

    const filename = extractFilename(
      response.headers.get('Content-Disposition'),
      artifact,
    )
    const objectUrl = URL.createObjectURL(blob)

    const anchor = hiddenAnchorRef.current
    if (anchor) {
      anchor.href = objectUrl
      anchor.download = filename
      anchor.click()
    }

    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)

    setStateForId(id, { downloading: false, error: null })
  }

  return (
    <div className="p-6">
      {/* Hidden anchor used for programmatic download triggering */}
      <a ref={hiddenAnchorRef} className="sr-only" aria-hidden="true"></a>

      <div className="overflow-x-auto rounded-md border border-neutral-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-800 bg-neutral-900">
              <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Name</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Type</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Size</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Created</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Storage Key</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Download</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800/60">
            {artifacts.map((artifact) => {
              const state = downloadStates[artifact.id]
              const isDownloading = state?.downloading ?? false
              const error = state?.error ?? null

              return (
                <tr
                  key={artifact.id}
                  className="hover:bg-neutral-900/40 transition-colors"
                >
                  <td className="px-4 py-3 font-mono text-neutral-200">{artifact.name}</td>
                  <td className="px-4 py-3 text-neutral-400 font-mono text-xs">{artifact.mimeType}</td>
                  <td className="px-4 py-3 text-neutral-400 tabular-nums">{formatBytes(artifact.size)}</td>
                  <td className="px-4 py-3 text-neutral-500 tabular-nums">{formatDate(artifact.createdAt)}</td>
                  <td
                    className="px-4 py-3 font-mono text-xs text-pewter truncate max-w-xs"
                    title={artifact.storageKey}
                  >
                    {artifact.storageKey}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      {isDownloading ? (
                        <span className="text-xs text-neutral-500 font-mono select-none">
                          Downloading…
                        </span>
                      ) : (
                        <button
                          type="button"
                          title="Download artifact"
                          onClick={() => { void handleDownload(artifact) }}
                          className="inline-flex items-center justify-center w-7 h-7 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 transition-colors duration-75 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 14 14"
                            fill="none"
                            xmlns="http://www.w3.org/2000/svg"
                            aria-hidden="true"
                          >
                            <path
                              d="M7 1v8M4 6l3 3 3-3M2 11h10"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                          <span className="sr-only">Download</span>
                        </button>
                      )}
                      {error !== null && (
                        <p className="text-xs text-destructive-400 leading-tight max-w-[12rem]">
                          {error}
                        </p>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
