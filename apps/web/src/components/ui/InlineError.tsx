// Compact inline error for additive/non-fatal fetch failures — a slimmer
// variant of ErrorState for use inside tab panels and sections where a full
// error card would be too loud. Neon-styled: near-black surface, 4px radius,
// red-alert dot, Pewter/neutral text (design.md).

interface InlineErrorProps {
  message: string
  className?: string
}

export function InlineError({ message, className }: InlineErrorProps) {
  return (
    <div
      role="alert"
      className={[
        'flex items-center gap-2 px-3 py-2.5 rounded-[4px] border border-graphite bg-graphite-deep text-xs text-neutral-400',
        className ?? '',
      ].join(' ')}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-destructive-500 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  )
}
