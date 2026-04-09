interface EmptyStateAction {
  label: string
  onClick: (() => void) | undefined
}

interface EmptyStateProps {
  title: string
  description?: string
  action?: EmptyStateAction
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <div className="w-10 h-10 rounded-full bg-neutral-800 border border-neutral-700 flex items-center justify-center mb-4">
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          className="text-neutral-500"
        >
          <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5.5 8h5M8 5.5v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>
      <h3 className="text-sm font-semibold text-neutral-300">{title}</h3>
      {description && (
        <p className="mt-1.5 text-sm text-neutral-500 max-w-sm leading-relaxed">{description}</p>
      )}
      {action && action.onClick && (
        <button
          onClick={action.onClick}
          className="mt-5 inline-flex items-center px-3.5 py-2 text-sm font-medium rounded-md bg-primary-600 hover:bg-primary-700 text-white transition-colors duration-100"
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
