import { LoadingState } from '@/components/ui/LoadingState'

export default function BlastRadiusLoading() {
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <LoadingState message="Replaying recorded runs against the target version…" />
    </div>
  )
}
