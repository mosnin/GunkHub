/**
 * Vitest `setupFiles` entry — runs before EVERY test file in this package,
 * including the 67 that run under `environment: 'node'`.
 *
 * It is therefore deliberately almost empty. The DOM harness (jest-dom
 * matchers, React Testing Library auto-cleanup) is loaded through a dynamic
 * import gated on a real `document` existing, so a node-environment file pays
 * one `typeof` check and nothing else — no jsdom, no React, no testing-library
 * module graph. That is what keeps the existing suites at their current speed
 * while still giving DOM files a single, shared, non-optional setup.
 *
 * A test file opts INTO the DOM by declaring `@vitest-environment jsdom` in
 * its first docblock. See CONTRIBUTING.md § Verification gates.
 */
if (typeof document !== 'undefined') {
  await import('./dom')
}

// Marks this file as a module, which is what permits the top-level `await`
// above. It has no exports of its own.
export {}
