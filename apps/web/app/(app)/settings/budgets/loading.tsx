import { LoadingState } from '@/components/ui/LoadingState'

/**
 * The message names BOTH reads this page performs, because they take
 * noticeably different times: the budget rows are an indexed listing, while the
 * breaker evaluation sums spend at query time. A generic "Loading…" would make
 * the slower of the two look like a hang.
 */
export default function SettingsBudgetsLoading() {
  return <LoadingState message="Reading budgets and evaluating breakers…" />
}
