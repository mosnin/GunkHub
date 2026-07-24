/**
 * DOM-only test setup. Loaded by `tests/setup/global.ts` ONLY when the test
 * file declared `@vitest-environment jsdom`, so nothing here is evaluated for
 * the node-environment suites.
 *
 * Two things, both of which every DOM test needs and none of which a test
 * should have to remember:
 *
 *  1. `@testing-library/jest-dom` matchers (`toHaveAccessibleName`,
 *     `toHaveAttribute`, `toBeVisible`, …). These are the vocabulary that
 *     makes a rendered-DOM assertion read like the accessibility claim it is
 *     making, rather than like a property lookup.
 *  2. Unmount-between-tests. RTL registers this itself when a global
 *     `afterEach` exists (it does — `globals: true`), but it is registered
 *     explicitly here so the guarantee does not depend on that config staying
 *     true. Without it, `screen.getByRole` searches every previously rendered
 *     tree at once and "exactly one tab stop" style assertions become
 *     meaningless.
 */
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

import '@testing-library/jest-dom/vitest'

afterEach(() => {
  cleanup()
})
