import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'

export default async function RootPage() {
  const { userId } = await auth()

  if (userId) {
    redirect('/dashboard')
  }

  return (
    <div className="min-h-screen bg-neutral-950 flex items-center justify-center px-4">
      <div className="max-w-sm w-full">
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-7 h-7 bg-primary-600 rounded flex items-center justify-center">
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <circle cx="7" cy="7" r="2.5" fill="white" />
                <path d="M7 1v2M7 11v2M1 7h2M11 7h2" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
            <span className="text-sm font-semibold tracking-tight text-neutral-100">
              Agent Flight Recorder
            </span>
          </div>
          <h1 className="text-2xl font-bold text-neutral-100 tracking-tight leading-tight">
            Make agent failures<br />explainable.
          </h1>
          <p className="mt-3 text-sm text-neutral-400 leading-relaxed">
            Capture, replay, and diff every agent run. Understand exactly what went wrong, when, and why.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <Link
            href="/sign-in"
            className="w-full inline-flex items-center justify-center px-4 py-2.5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-md transition-colors duration-150"
          >
            Sign in
          </Link>
          <Link
            href="/sign-up"
            className="w-full inline-flex items-center justify-center px-4 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-100 text-sm font-medium rounded-md border border-neutral-700 transition-colors duration-150"
          >
            Create account
          </Link>
        </div>

        <p className="mt-6 text-xs text-neutral-600 text-center">
          By continuing, you agree to our Terms of Service and Privacy Policy.
        </p>
      </div>
    </div>
  )
}
