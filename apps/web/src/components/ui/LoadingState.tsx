interface LoadingStateProps {
  message?: string
}

export function LoadingState({ message }: LoadingStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <div
        className="w-6 h-6 rounded-full border-2 border-graphite-light border-t-neon-glow animate-spin mb-4"
        role="status"
        aria-label="Loading"
      />
      {message && (
        <p className="text-sm text-neutral-500">{message}</p>
      )}
    </div>
  )
}
