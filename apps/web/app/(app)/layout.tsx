import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'

import { KeyboardLayer } from '@/components/keyboard/KeyboardLayer'
import { AppShell } from '@/components/layout/AppShell'

export default function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { userId } = auth()

  if (!userId) {
    redirect('/sign-in')
  }

  return (
    <>
      <AppShell>{children}</AppShell>
      <KeyboardLayer />
    </>
  )
}
