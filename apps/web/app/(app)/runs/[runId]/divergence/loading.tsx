import { LoadingState } from '@/components/ui/LoadingState'

export default function RunDivergenceLoading() {
  return (
    <div className="p-6 max-w-5xl mx-auto">
      <LoadingState message="Checking this run's recorded events against the target version…" />
    </div>
  )
}
