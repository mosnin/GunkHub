import { LoadingState } from '@/components/ui/LoadingState'

export default function PatternsLoading() {
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <LoadingState message="Loading failure patterns…" />
    </div>
  )
}
