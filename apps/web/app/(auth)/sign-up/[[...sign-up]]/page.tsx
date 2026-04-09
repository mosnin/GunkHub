import { SignUp } from '@clerk/nextjs'

export default function SignUpPage() {
  return (
    <div className="min-h-screen bg-neutral-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <span className="text-sm font-semibold text-neutral-100 tracking-tight">
            Agent Flight Recorder
          </span>
        </div>
        <SignUp
          appearance={{
            variables: {
              colorBackground: '#171717',
              colorText: '#f5f5f5',
              colorTextSecondary: '#a3a3a3',
              colorInputBackground: '#262626',
              colorInputText: '#f5f5f5',
              colorPrimary: '#2563eb',
              borderRadius: '0.375rem',
            },
            elements: {
              card: 'shadow-none border border-neutral-800',
              headerTitle: 'text-neutral-100',
              headerSubtitle: 'text-neutral-400',
              formFieldLabel: 'text-neutral-300',
              footerActionLink: 'text-primary-400 hover:text-primary-300',
            },
          }}
        />
      </div>
    </div>
  )
}
