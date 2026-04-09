import { ClerkProvider } from '@clerk/nextjs'

import { Providers } from './providers'
import './globals.css'

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: {
    default: 'Agent Flight Recorder',
    template: '%s — Agent Flight Recorder',
  },
  description: 'Make agent failures explainable. Capture, replay, and diff every agent run.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="bg-neutral-950 text-neutral-100 font-sans antialiased min-h-screen">
        <ClerkProvider>
          <Providers>{children}</Providers>
        </ClerkProvider>
      </body>
    </html>
  )
}
