/**
 * The MCP package version, advertised to clients in the initialize handshake.
 *
 * Kept as a plain const (mirroring `packages/cli/src/version.ts` and
 * `packages/sdk/src/version.ts`) rather than reading `package.json` at runtime,
 * since the built `dist/index.js` has no guaranteed relative path back to
 * `package.json` once installed globally. Update BOTH when bumping the version.
 */
export const MCP_VERSION = '0.1.0'
