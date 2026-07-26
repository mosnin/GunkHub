import { LoadingState } from '@/components/ui/LoadingState'

/**
 * Names the work, not just its existence.
 *
 * "Walking recorded links" tells a reader that this page is doing a multi-hop
 * traversal — which is why it is not instant, and why an empty result a moment
 * later is the result of a walk rather than a stall. It also plants the word
 * RECORDED before any chain appears: the answer will only ever be as complete
 * as what was written down.
 */
export default function CausalLoading() {
  return (
    <div className="p-6 max-w-5xl mx-auto">
      <LoadingState message="Walking recorded links between runs…" />
    </div>
  )
}
