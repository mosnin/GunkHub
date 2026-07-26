'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'

const MAX_ENV_LENGTH = 32

interface EnvironmentFilterInputProps {
  /** Currently active custom (non-preset) environment value, if any. */
  customEnvironment?: string
}

/**
 * Free-text custom environment filter (ADR-002 allows any environment string
 * up to 32 chars, not just the 4 quick-filter presets). Reads/writes the same
 * `?environment=` URL param the server-rendered pills use, so it stays
 * shareable — this component only needs client interactivity for the text
 * input and remove action, not for fetching data.
 */
export function EnvironmentFilterInput({ customEnvironment }: EnvironmentFilterInputProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  function pushEnvironment(env: string | undefined) {
    const params = new URLSearchParams(searchParams.toString())
    params.delete('cursor')
    if (env) {
      params.set('environment', env)
    } else {
      params.delete('environment')
    }
    const qs = params.toString()
    router.push(`/runs${qs ? `?${qs}` : ''}`)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) return
    if (trimmed.length > MAX_ENV_LENGTH) {
      setError(`Environment must be ${String(MAX_ENV_LENGTH)} characters or fewer`)
      return
    }
    setError(null)
    pushEnvironment(trimmed)
    setValue('')
  }

  if (customEnvironment) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono font-medium border bg-primary-900 text-primary-300 border-primary-700">
        {customEnvironment}
        <button
          type="button"
          onClick={() => pushEnvironment(undefined)}
          aria-label={`Remove custom environment filter ${customEnvironment}`}
          className="hover:text-whiteout transition-colors duration-100"
        >
          ×
        </button>
      </span>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-1">
      <input
        type="text"
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          setError(null)
        }}
        maxLength={MAX_ENV_LENGTH}
        placeholder="custom…"
        aria-label="Filter by custom environment"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'custom-env-error' : undefined}
        className="w-24 h-6 px-1.5 rounded text-xs font-mono bg-graphite-deep border border-graphite-light text-whiteout placeholder-pewter outline-none focus:ring-1 focus:ring-neon-glow"
      />
      {error && (
        <span id="custom-env-error" role="alert" className="text-[10px] text-destructive-400">
          {error}
        </span>
      )}
    </form>
  )
}
