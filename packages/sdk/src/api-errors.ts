import type { AfrApiErrorCode } from '@agent-flight-recorder/contracts'

/**
 * Error codes that make a run's pending event batch PERMANENTLY undeliverable:
 * the run is already terminal server-side (`RUN_NOT_ACTIVE`) or the sequence
 * range was already claimed (`SEQUENCE_CONFLICT`). Retrying can never succeed,
 * so the recorder drops the affected run's events (surfaced via
 * `onDrop(count, 'rejected_by_server')`) instead of retrying them forever and
 * blocking other runs' delivery.
 *
 * The member literals are typed against the contracts `AfrApiErrorCode` union
 * (`packages/contracts/src/api_errors.ts`), so a contracts-side rename fails
 * this package's typecheck instead of silently breaking the string match.
 */
export const NON_RETRYABLE_RUN_ERROR_CODES: ReadonlySet<string> = new Set<AfrApiErrorCode>([
  'RUN_NOT_ACTIVE',
  'SEQUENCE_CONFLICT',
])
