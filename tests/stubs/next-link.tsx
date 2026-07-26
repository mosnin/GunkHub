/**
 * Test stub for `next/link`.
 *
 * WHY THIS EXISTS: `next` is a dependency of `apps/web` only, so under pnpm's
 * isolated `node_modules` the bare specifier `next/link` is not resolvable
 * from `tests/`. Same problem, same fix, as `tests/stubs/clerk-server.ts` —
 * see `tests/vitest.config.ts` for the alias.
 *
 * WHY A STUB RATHER THAN THE REAL `next/link`: the real component reads
 * `AppRouterContext` on mount and throws outside a Next app tree, so rendering
 * it would require standing up a router mock whose only observable effect on
 * these tests is... rendering an `<a>`. That is not a more faithful test, it is
 * the same test with more scaffolding between the assertion and the thing
 * asserted.
 *
 * WHAT IT MUST NOT DO: swallow any prop an accessibility assertion reads. This
 * stub strips ONLY Next's own navigation options (`prefetch`, `replace`,
 * `scroll`, `shallow`, `passHref`, `legacyBehavior`, `locale`) — none of which
 * reach the DOM in the real component either — and forwards every remaining
 * prop verbatim, including `tabIndex`, `aria-*`, `title`, `className`,
 * `onClick` and children. `href` is stringified the way the real component
 * stringifies a `UrlObject`, so `getByRole('link')` sees a real link with a
 * real `href` and the accessible-name computation runs over real children.
 *
 * If a test ever needs to assert something about Next's routing behaviour
 * rather than the rendered anchor, it needs a real Next test environment —
 * not an extension of this file.
 */
import * as React from 'react'

/** Mirrors the `UrlObject` shape `next/link` accepts, to the extent an href is observable in the DOM. */
interface UrlObjectLike {
  pathname?: string | null
  search?: string | null
  hash?: string | null
  query?: Record<string, string | number> | null
}

type NextLinkOnlyProps = {
  prefetch?: unknown
  replace?: unknown
  scroll?: unknown
  shallow?: unknown
  passHref?: unknown
  legacyBehavior?: unknown
  locale?: unknown
}

export type StubLinkProps = Omit<React.ComponentPropsWithoutRef<'a'>, 'href'> &
  NextLinkOnlyProps & {
    href: string | UrlObjectLike
  }

function hrefToString(href: string | UrlObjectLike): string {
  if (typeof href === 'string') return href
  const pathname = href.pathname ?? ''
  const query = href.query
    ? Object.entries(href.query)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')
    : ''
  const search = href.search ?? (query ? `?${query}` : '')
  return `${pathname}${search}${href.hash ?? ''}`
}

export default function Link({
  href,
  children,
  // Next-only navigation options. Deliberately destructured out so React does
  // not warn about unknown DOM attributes — the real component drops them too.
  prefetch: _prefetch,
  replace: _replace,
  scroll: _scroll,
  shallow: _shallow,
  passHref: _passHref,
  legacyBehavior: _legacyBehavior,
  locale: _locale,
  ...rest
}: StubLinkProps) {
  return (
    <a href={hrefToString(href)} {...rest}>
      {children}
    </a>
  )
}
