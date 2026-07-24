/**
 * The SDK package version, reported to the server as `sdkVersion` on run
 * creation by both `Recorder` and `FlightRecorder`.
 *
 * Kept as a plain const (rather than reading package.json at runtime) so the
 * SDK stays bundler-safe in browser/edge/Lambda environments with no
 * filesystem. A unit test asserts this stays in sync with package.json —
 * update BOTH when bumping the version.
 */
export const SDK_VERSION = '0.8.0'
