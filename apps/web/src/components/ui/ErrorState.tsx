interface ErrorStateProps {
  title: string
  message?: string
  retry?: () => void
}

export function ErrorState({ title, message, retry }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <div className="w-10 h-10 rounded-full bg-destructive-900 border border-destructive-700 flex items-center justify-center mb-4">
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          className="text-destructive-400"
        >
          <path
            d="M8 5v3.5M8 10.5v.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <path
            d="M6.68 2.5L1.5 11a1.5 1.5 0 001.32 2.25h10.36A1.5 1.5 0 0014.5 11L9.32 2.5a1.5 1.5 0 00-2.64 0z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h3 className="text-sm font-semibold text-neutral-300">{title}</h3>
      {message && (
        <p className="mt-1.5 text-sm text-neutral-500 max-w-sm leading-relaxed">{message}</p>
      )}
      {retry && (
        <button
          onClick={retry}
          className="mt-5 inline-flex items-center px-3.5 py-2 text-sm font-medium rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-100 border border-neutral-700 transition-colors duration-100"
        >
          Try again
        </button>
      )}
    </div>
  )
}
