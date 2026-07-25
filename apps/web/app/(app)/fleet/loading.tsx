import { LoadingState } from '@/components/ui/LoadingState'

/**
 * The loading state names what is being done, not just that something is.
 * "Correlating failures across the fleet…" tells a reader mid-incident that
 * the page is doing a cross-agent walk — which is why it is not instant, and
 * why an empty result a second later is a scan result rather than a stall.
 */
export default function FleetLoading() {
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <LoadingState message="Correlating failures across the fleet…" />
    </div>
  )
}
