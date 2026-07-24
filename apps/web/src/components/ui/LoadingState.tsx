interface LoadingStateProps {
  message?: string
}

export function LoadingState({ message }: LoadingStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      {/*
        Motion is gated at the component, not left to a global rule.

        The bare `animate-spin` this replaces was covered by globals.css's
        reduced-motion block — but only because that block names `.animate-spin`
        explicitly. A source scanner reading component files cannot see that
        coupling, and neither can a reader of this file. Worse, LoadingState is
        composed into audited surfaces (ResolutionEvidencePanel's loading
        state), so the ungated token travelled into files no scanner opened.

        Both directions are now declared here. This deliberately does NOT stop
        the animation under reduced motion: it slows it to 2s, matching the
        considered precedent in globals.css:131 — the spinner is the only
        signal that the app is working, and freezing it reads as a hang.
      */}
      <div
        className="w-6 h-6 rounded-full border-2 border-graphite-light border-t-neon-glow mb-4 motion-safe:animate-spin motion-reduce:animate-[spin_2s_linear_infinite]"
        role="status"
        aria-label="Loading"
      />
      {message && (
        <p className="text-sm text-pewter">{message}</p>
      )}
    </div>
  )
}
