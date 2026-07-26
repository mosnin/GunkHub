import { LoadingState } from '@/components/ui/LoadingState'

/**
 * The message names what is slow. This evaluation reads a page of runs and, for
 * each, an unfiltered page of that run's events — it is not an indexed lookup,
 * and a generic spinner would make a working scan look like a hang.
 */
export default function PolicyEvaluationLoading() {
  return <LoadingState message="Evaluating this policy over recorded runs…" />
}
