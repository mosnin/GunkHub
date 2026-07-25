/**
 * The CLI package version, printed by `afr version`.
 *
 * Kept as a plain const (mirroring `packages/sdk/src/version.ts`) rather than
 * reading `package.json` at runtime, since the built `dist/index.js` has no
 * guaranteed relative path back to `package.json` once installed globally. A
 * unit test asserts this stays in sync with `package.json` — update BOTH when
 * bumping the version.
 */
export const CLI_VERSION = '0.11.0'
