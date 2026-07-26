import Link from 'next/link'

interface EmptyStateAction {
  label: string
  /** Client-side action. Ignored when `href` is provided. */
  onClick?: (() => void) | undefined
  /** Internal route — renders a next/link styled like the action button, so
      server components can wire an action without a client handler. */
  href?: string
}

interface EmptyStateProps {
  title: string
  description?: string
  action?: EmptyStateAction
}

// Whiteout pill CTA (design.md: primary actions are Whiteout pills).
const ACTION_CLASSES =
  'mt-5 inline-flex items-center px-[18px] py-2 text-sm font-medium rounded-full bg-whiteout hover:bg-cloud text-graphite-deep transition-colors duration-150'

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <div className="w-10 h-10 rounded-full bg-graphite border border-graphite-light flex items-center justify-center mb-4">
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          className="text-pewter"
        >
          <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5.5 8h5M8 5.5v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>
      <h3 className="text-sm font-semibold text-neutral-300">{title}</h3>
      {description && (
        <p className="mt-1.5 text-sm text-pewter max-w-sm leading-relaxed">{description}</p>
      )}
      {action && action.href ? (
        <Link href={action.href} className={ACTION_CLASSES}>
          {action.label}
        </Link>
      ) : action && action.onClick ? (
        <button onClick={action.onClick} className={ACTION_CLASSES}>
          {action.label}
        </button>
      ) : null}
    </div>
  )
}
