'use client'

import { useEffect } from 'react'

interface GlobalErrorProps {
  error: Error & { digest?: string }
  reset: () => void
}

/**
 * Root-level error boundary. This replaces the root layout when the layout
 * itself throws, so it must render its own <html>/<body> and cannot rely on
 * globals.css or Tailwind classes being applied. Styling is inline and self
 * contained, using Neon tokens directly: Blackout ground (#000), Whiteout text
 * (#fff), Neon Glow accent (#34d59a), System Warning (#ff3621), 4px container
 * radius, 9999px pill button.
 */
export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#000000',
          color: '#ffffff',
          fontFamily:
            "'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif",
          padding: '24px',
        }}
      >
        <div style={{ maxWidth: '360px', textAlign: 'center' }}>
          <span
            style={{
              fontFamily:
                "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: '13px',
              letterSpacing: '0.05em',
              color: '#ff3621',
            }}
          >
            APPLICATION ERROR
          </span>
          <h1
            style={{
              marginTop: '12px',
              marginBottom: 0,
              fontSize: '24px',
              fontWeight: 500,
              letterSpacing: '-0.24px',
              color: '#ffffff',
            }}
          >
            Something went wrong
          </h1>
          <p
            style={{
              marginTop: '8px',
              fontSize: '14px',
              lineHeight: 1.5,
              color: '#797d86',
            }}
          >
            {error.message ||
              'A critical error occurred and the application could not recover.'}
          </p>
          <button
            onClick={reset}
            style={{
              marginTop: '24px',
              border: '1px solid #303236',
              borderRadius: '9999px',
              backgroundColor: 'transparent',
              color: '#ffffff',
              fontSize: '14px',
              fontWeight: 500,
              padding: '12px 18px',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  )
}
