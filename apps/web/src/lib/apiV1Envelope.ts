/**
 * apiV1Envelope.ts — the stable JSON envelope every `/api/v1/**` success
 * response is wrapped in. Error responses keep the existing `ApiError` shape
 * (`{ code, message, details }`) used everywhere else in this API — only the
 * success shape gets the envelope, so a client can always tell success from
 * error by response status plus the presence of `data`.
 *
 * `apiVersion` is a date-versioned string (matching the convention already
 * used for the webhook payload envelope in docs/design/action_layer.md), not
 * a running integer — it changes only on a breaking change to this envelope
 * shape, not on every deploy. Bump it in ONE place if that ever happens.
 */
export const API_V1_VERSION = '2026-07-19'

export interface ApiV1Envelope<T> {
  apiVersion: string
  data: T
  requestId: string
}

export function apiV1Envelope<T>(data: T, requestId: string): ApiV1Envelope<T> {
  return { apiVersion: API_V1_VERSION, data, requestId }
}
