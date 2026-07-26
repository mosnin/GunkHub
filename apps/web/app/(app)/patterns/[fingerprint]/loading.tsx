import { LoadingState } from '@/components/ui/LoadingState'

export default function PatternDetailLoading() {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <LoadingState message="Loading pattern detail…" />
    </div>
  )
}
