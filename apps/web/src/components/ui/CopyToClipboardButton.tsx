'use client'

import { useState } from 'react'

interface CopyToClipboardButtonProps {
  /** The text written to the clipboard. */
  value: string
  /** Accessible name; defaults to "Copy to clipboard". */
  label?: string
  className?: string
}

/**
 * Small copy-to-clipboard affordance with transient "copied" feedback.
 * Same interaction pattern as RunHeader's CopyButton, packaged for reuse
 * by server components (e.g. CodeBlock).
 */
export function CopyToClipboardButton({
  value,
  label = 'Copy to clipboard',
  className,
}: CopyToClipboardButtonProps) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={label}
      aria-label={label}
      className={[
        // House focus ring, matching ui/Button.tsx. This control previously
        // declared none and relied on whatever the surrounding row happened to
        // supply (PatternRow's `focus:opacity-100` made it visible but is not
        // an indicator), so on the Blackout ground it fell back to the UA
        // hairline. globals.css adds a forced-colors outline on top of this.
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono transition-colors duration-100 hover:bg-neutral-800',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow focus-visible:ring-offset-2 focus-visible:ring-offset-blackout',
        copied ? 'text-neon-glow' : 'text-pewter hover:text-cloud',
        className ?? '',
      ].join(' ')}
    >
      {copied ? (
        <>
          {/* Checkmark icon */}
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          copied
        </>
      ) : (
        <>
          {/* Copy icon */}
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <rect x="4" y="4" width="6" height="7" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <path d="M2 8V2a1 1 0 011-1h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          copy
        </>
      )}
    </button>
  )
}
