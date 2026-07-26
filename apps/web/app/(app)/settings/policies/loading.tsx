import { LoadingState } from '@/components/ui/LoadingState'

/**
 * The message names what is being read. A generic "Loading…" on a compliance
 * surface is the one place a spinner is actively unhelpful: an operator who
 * cannot tell whether the list is loading or empty will read an empty screen as
 * "no controls", which is a conclusion they should never reach by accident.
 */
export default function SettingsPoliciesLoading() {
  return <LoadingState message="Reading policy definitions…" />
}
