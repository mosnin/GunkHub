import { collectRunIds, expect, expectNotFallbackState, seedRequirement, test } from './support/journey'

/**
 * The authenticated journey — the spine of the product.
 *
 * Runs only when playwright.config.ts detects a configured authenticated tier
 * (see support/auth-tier.ts). Every test here reuses the storage state written
 * by auth.setup.ts, so each starts already signed in with an ACTIVE Clerk
 * organization.
 *
 * DESIGN PRINCIPLE FOR ASSERTIONS IN THIS FILE
 * A 200 proves nothing. `apps/web` renders a well-designed empty state for
 * every data-dependent view, so a backend call that silently returns nothing
 * produces a page that looks correct and returns 200. Assertions here therefore
 * do three things a smoke test does not:
 *
 *   1. Assert that real data is present AND that the empty/error copy for that
 *      view is absent. Both halves are required — the second is what catches a
 *      silent backend miss.
 *   2. Carry a value ACROSS a navigation and re-assert it (the run id shown in
 *      the list must be the run id shown on the detail page's h1). This catches
 *      a query returning the wrong document, which a single-page assertion
 *      cannot see.
 *   3. Re-assert state AFTER a reload for anything that was mutated. The
 *      lifecycle controls are non-optimistic, so a value that survives a reload
 *      was genuinely persisted server-side rather than just rendered locally.
 *
 * The `failureWatch` auto-fixture additionally fails any test whose journey
 * produced a 5xx response or an uncaught page error.
 *
 * Selector notes: apps/web has NO data-testid attributes anywhere, so selectors
 * here lean on roles, aria-labels, aria-current and hrefs (stable) rather than
 * body copy (not stable). Where copy is unavoidable it is quoted exactly from
 * the component.
 */

test.describe('authenticated journey', () => {
  test('app shell renders for a signed-in user with an active organization', async ({ page }) => {
    await page.goto('/dashboard')

    // Reaching /dashboard at all proves clerkMiddleware's auth().protect() let
    // us through; an unauthenticated request is redirected to /sign-in.
    await expect(page).toHaveURL(/\/dashboard(\?|$)/)
    await expectNotFallbackState(page, 'app shell')

    // Every sidebar destination, asserted by href so a copy edit does not fail
    // the test but a removed/renamed route does.
    const navHrefs = ['/dashboard', '/projects', '/agents', '/runs', '/patterns', '/search', '/diff', '/audit', '/settings']
    for (const href of navHrefs) {
      await expect(page.locator(`a[href="${href}"]`).first(), `sidebar link ${href}`).toBeVisible()
    }

    // Sidebar marks the current route; a broken active-state calculation is a
    // real navigation bug and invisible to a status-code check.
    await expect(page.locator('a[href="/dashboard"][aria-current="page"]').first()).toBeVisible()
  })

  test('dashboard renders real org data (not the no-runs zero state)', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
    await expectNotFallbackState(page, 'dashboard')

    // THE key assertion. When listRuns returns nothing, the dashboard renders a
    // "Getting Started" card that looks like a perfectly healthy onboarding
    // screen. Against a seeded org, seeing it means the backend answered with
    // nothing — exactly the silent failure this tier is here to catch.
    await expect(
      page.getByRole('heading', { name: 'Getting Started' }),
      seedRequirement('at least one recorded run'),
    ).toBeHidden()
    await expect(page.getByRole('heading', { name: 'Recent Runs' })).toBeVisible()

    // Analytics come from a different Convex path (rollups) than the run list,
    // so assert it independently rather than assuming one implies the other.
    await expect(
      page.getByRole('heading', { level: 3, name: "Couldn't load dashboard analytics" }),
      'dashboard analytics failed to load',
    ).toBeHidden()
    await expect(page.getByText('Total runs', { exact: true })).toBeVisible()
    await expect(page.getByText('Failure rate', { exact: true })).toBeVisible()

    // The run table under "Recent Runs" must actually contain rows.
    const runIds = await collectRunIds(page)
    expect(runIds.length, seedRequirement('runs linked from the dashboard')).toBeGreaterThan(0)
  })

  test('runs list renders real runs (not the empty state)', async ({ page }) => {
    await page.goto('/runs')
    await expect(page.getByRole('heading', { level: 1, name: 'Runs' })).toBeVisible()
    await expectNotFallbackState(page, 'runs list')

    await expect(
      page.getByRole('heading', { level: 3, name: 'No runs recorded yet.' }),
      seedRequirement('at least one recorded run'),
    ).toBeHidden()

    // Column headers prove the table rendered its data shape, not a placeholder.
    for (const column of ['Run ID', 'Status', 'Agent', 'Started', 'Duration']) {
      await expect(page.getByRole('columnheader', { name: column })).toBeVisible()
    }

    const runIds = await collectRunIds(page)
    expect(runIds.length, seedRequirement('runs on /runs')).toBeGreaterThan(0)

    // The status filter is applied server-side via a query param; a filter that
    // silently ignores its input is a class of bug no unauthenticated test can
    // reach. Assert the filtered view is internally consistent rather than
    // asserting a specific count.
    await page.goto('/runs?status=completed')
    await expectNotFallbackState(page, 'runs list filtered by status')
    const statusCells = page.locator('tbody tr td:nth-child(3)')
    const statusCount = await statusCells.count()
    if (statusCount > 0) {
      const texts = await statusCells.allInnerTexts()
      for (const text of texts) {
        expect(
          text.trim(),
          'A run whose status is not "completed" appeared under ?status=completed — the filter is not being applied.',
        ).toBe('completed')
      }
    }
  })

  test('run detail renders the event trace for the run opened from the list', async ({ page }) => {
    await page.goto('/runs')
    const runLink = page.locator('a[href^="/runs/"]').first()
    await expect(runLink, seedRequirement('a run to open')).toBeVisible()

    // Capture what the LIST claims, so we can prove the DETAIL page agrees.
    // Both render truncateId(id, 12), so the strings must match exactly.
    const listLabel = (await runLink.innerText()).trim()
    const href = await runLink.getAttribute('href')
    expect(href).toBeTruthy()

    await runLink.click()
    await expect(page).toHaveURL(new RegExp(`${href ?? ''}(\\?|$)`))
    await expectNotFallbackState(page, 'run detail')

    // Cross-navigation consistency: a query that returns the wrong run, or an
    // empty run, fails here and nowhere else.
    await expect(
      page.getByRole('heading', { level: 1, name: listLabel }),
      'The run detail h1 does not match the run id shown in the list — the detail query returned a different or empty document.',
    ).toBeVisible()

    // Section tabs.
    const tabNav = page.getByRole('navigation', { name: 'Run sections' })
    await expect(tabNav).toBeVisible()
    for (const tab of ['Timeline', 'Events', 'Artifacts', 'Comments']) {
      await expect(tabNav.getByRole('link', { name: tab })).toBeVisible()
    }

    // The event log itself. RUN_STARTED is always sequence #1 per the event log
    // rules in CLAUDE.md, so its absence is a real invariant violation.
    const timeline = page.getByRole('group', { name: 'Event timeline' })
    await expect(timeline).toBeVisible()
    await expect(
      page.getByRole('heading', { level: 3, name: 'No events' }),
      seedRequirement('a run with recorded events'),
    ).toBeHidden()

    const eventRows = timeline.getByRole('button')
    const rowCount = await eventRows.count()
    expect(rowCount, seedRequirement('events on the opened run')).toBeGreaterThan(0)
    await expect(timeline.getByText('#1', { exact: true }).first()).toBeVisible()
  })

  test('event inspector renders a real payload for a selected event', async ({ page }) => {
    await page.goto('/runs')
    const href = await page.locator('a[href^="/runs/"]').first().getAttribute('href')
    expect(href, seedRequirement('a run to inspect')).toBeTruthy()

    await page.goto(`${href ?? ''}?tab=events`)
    await expectNotFallbackState(page, 'event inspector')

    const eventList = page.getByRole('listbox', { name: 'Events' })
    await expect(eventList).toBeVisible()

    const options = eventList.getByRole('option')
    const optionCount = await options.count()
    expect(optionCount, seedRequirement('events to inspect')).toBeGreaterThan(0)

    await options.first().click()
    await expect(options.first()).toHaveAttribute('aria-selected', 'true')

    // Before selection the panel reads "Select an event to inspect its payload";
    // its disappearance plus non-empty JSON proves the payload actually loaded.
    await expect(page.getByText('Select an event to inspect its payload')).toBeHidden()
    const payload = page.locator('pre').first()
    await expect(payload).toBeVisible()
    const payloadText = (await payload.innerText()).trim()
    expect(payloadText.length, 'The event payload panel rendered but is empty.').toBeGreaterThan(2)
    expect(() => JSON.parse(payloadText)).not.toThrow()

    // Selecting an event writes ?event=<sequenceNumber> so the view is
    // shareable — a stable-URL guarantee CLAUDE.md calls out explicitly.
    await expect(page).toHaveURL(/[?&]event=\d+/)
  })

  test('replay renders derived frames and declares itself a projection', async ({ page }) => {
    await page.goto('/runs')
    const href = await page.locator('a[href^="/runs/"]').first().getAttribute('href')
    expect(href, seedRequirement('a run to replay')).toBeTruthy()

    await page.goto(`${href ?? ''}/replay`)
    await expectNotFallbackState(page, 'replay')

    // Replay is a derived projection, never source of truth (CLAUDE.md event
    // log rule 2). The banner is the user-facing expression of that rule.
    await expect(page.getByText('Replay is a derived projection. The event log is not modified.')).toBeVisible()

    await expect(
      page.getByRole('heading', { level: 3, name: 'No frames' }),
      seedRequirement('a run with events to replay'),
    ).toBeHidden()

    // "Frame 1 / N" is computed from the projection; N === 0 would mean the
    // derivation produced nothing from a run that demonstrably has events.
    const frameCounter = page.getByText(/^Frame \d+ \/ \d+$/)
    await expect(frameCounter).toBeVisible()
    const initial = (await frameCounter.innerText()).trim()
    const total = Number(/\/\s*(\d+)$/.exec(initial)?.[1] ?? '0')
    expect(total, 'The replay projection produced zero frames for a run that has events.').toBeGreaterThan(0)

    // Stepping must actually move — a dead control is invisible to a page load.
    if (total > 1) {
      await page.getByRole('button', { name: 'Next frame' }).click()
      await expect(frameCounter).not.toHaveText(initial)
    }
  })

  test('diff compares two real runs and reports a summary', async ({ page }) => {
    await page.goto('/runs')
    const runIds = await collectRunIds(page)
    expect(runIds.length, seedRequirement('two runs to compare')).toBeGreaterThan(1)

    const [left, right] = runIds
    await page.goto(`/diff?left=${encodeURIComponent(left ?? '')}&right=${encodeURIComponent(right ?? '')}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Compare Runs' })).toBeVisible()
    await expectNotFallbackState(page, 'diff')

    // The selector-only state means the params were dropped or the diff query
    // returned nothing — both silent failures that still render a clean page.
    await expect(
      page.getByRole('heading', { level: 3, name: 'No runs selected' }),
      'The diff page fell back to its selector state despite left/right params being supplied.',
    ).toBeHidden()

    await expect(page.getByText('Run A', { exact: true })).toBeVisible()
    await expect(page.getByText('Run B', { exact: true })).toBeVisible()

    // The four summary badges are computed from the derived diff. Their
    // presence proves the projection ran; identical runs legitimately produce
    // "No differences", which is a valid outcome, so accept either shape.
    const summary = page.getByText(/^[+\-~=]\d+ (added|removed|changed|same)$/)
    const noDifferences = page.getByRole('heading', { level: 3, name: 'No differences' })
    const summaryCount = await summary.count()
    if (summaryCount === 0) {
      await expect(
        noDifferences,
        'The diff rendered neither a change summary nor the "No differences" state — the projection returned nothing.',
      ).toBeVisible()
    } else {
      expect(summaryCount).toBeGreaterThan(0)
    }
  })

  test('failure patterns list renders and links through to pattern detail', async ({ page }) => {
    await page.goto('/patterns')
    await expect(page.getByRole('heading', { level: 1, name: 'Patterns' })).toBeVisible()
    await expectNotFallbackState(page, 'patterns list')

    // The status filter group is the lifecycle's read surface.
    const filters = page.getByRole('group', { name: 'Filter patterns by status' })
    await expect(filters).toBeVisible()
    for (const label of ['All', 'Open', 'Acknowledged', 'Resolved', 'Regressed']) {
      await expect(filters.getByRole('link', { name: new RegExp(`^${label}\\b`) })).toBeVisible()
    }

    await expect(
      page.getByRole('heading', { level: 3, name: 'No recurring failure patterns yet' }),
      seedRequirement('at least one recurring failure pattern'),
    ).toBeHidden()

    const patternLink = page.locator('a[href^="/patterns/"]').first()
    await expect(patternLink, seedRequirement('a failure pattern to open')).toBeVisible()
    const label = (await patternLink.innerText()).trim()

    await patternLink.click()
    await expectNotFallbackState(page, 'pattern detail')

    // Same cross-navigation consistency check as runs: the detail page must be
    // showing the pattern we clicked.
    await expect(page.getByRole('heading', { level: 1, name: label })).toBeVisible()
    await expect(page.getByRole('link', { name: 'All patterns' })).toBeVisible()
    await expect(page.getByText('Occurrences', { exact: true })).toBeVisible()

    // The regressed filter must render a real view — either matching rows or
    // its specific filtered-empty copy. A blank page here would mean the
    // regression status is not queryable at all.
    await page.goto('/patterns?status=regressed')
    await expectNotFallbackState(page, 'regressed pattern filter')
    await expect(filters.getByRole('link', { name: /^Regressed\b/ })).toHaveAttribute('aria-current', 'page')
    const regressedRows = await page.locator('a[href^="/patterns/"]').count()
    if (regressedRows === 0) {
      await expect(page.getByRole('heading', { level: 3, name: 'No regressed patterns' })).toBeVisible()
    }
  })

  test('resolution lifecycle round-trips through the server and survives a reload', async ({ page }) => {
    // Start from an OPEN pattern so the full acknowledge → resolve → reopen
    // cycle is available and the test restores the original state at the end.
    await page.goto('/patterns?status=open')
    await expectNotFallbackState(page, 'open patterns')

    const patternLink = page.locator('a[href^="/patterns/"]').first()
    await expect(patternLink, seedRequirement('an OPEN failure pattern to exercise the lifecycle against')).toBeVisible()
    const patternUrl = await patternLink.getAttribute('href')
    await patternLink.click()
    await expectNotFallbackState(page, 'pattern detail')

    // Badge text is uppercased in the DOM by PatternStatusBadge.
    const badge = page.getByTitle(/^status: /)
    await expect(badge).toHaveText('OPEN')

    // 1. Acknowledge. PatternLifecycleControl is deliberately non-optimistic —
    //    it reconciles from the server's { pattern } envelope — so the badge
    //    changing already proves a round trip. The reload proves it PERSISTED.
    await page.getByRole('button', { name: 'Acknowledge' }).click()
    await expect(badge).toHaveText('ACKNOWLEDGED')
    await page.reload()
    await expect(
      page.getByTitle(/^status: /),
      'Acknowledge appeared to succeed but did not survive a reload — the write never reached the backend.',
    ).toHaveText('ACKNOWLEDGED')

    // 2. Resolve, via the inline form.
    await page.getByRole('button', { name: 'Resolve' }).click()
    const resolveForm = page.getByRole('form', { name: 'Resolve this failure pattern' })
    await expect(resolveForm).toBeVisible()
    await resolveForm.getByRole('textbox').first().fill('Resolved by the e2e authenticated journey.')
    await page.getByRole('button', { name: 'Mark resolved' }).click()
    await expect(page.getByTitle(/^status: /)).toHaveText('RESOLVED')
    await page.reload()
    await expect(
      page.getByTitle(/^status: /),
      'Resolve did not persist across a reload.',
    ).toHaveText('RESOLVED')

    // A resolution is a claim until something exercises it. The evidence panel
    // is the product's own guard against treating it as proof, so assert it
    // appears rather than assuming resolution is the end of the story.
    await expect(page.getByRole('heading', { name: 'Did the fix hold?' })).toBeVisible()

    // The lifecycle log is append-only history rendered from the server. Both
    // transitions we just made must be in it.
    const lifecycle = page.getByRole('list', { name: 'Lifecycle history for this failure pattern' })
    await expect(lifecycle).toBeVisible()
    await expect(lifecycle.getByText('Acknowledged', { exact: true })).toBeVisible()
    await expect(lifecycle.getByText('Resolved', { exact: true })).toBeVisible()

    // 3. Reopen, restoring the pattern to its original state so this test is
    //    idempotent against a long-lived seeded deployment.
    await page.getByRole('button', { name: 'Reopen' }).click()
    await expect(page.getByTitle(/^status: /)).toHaveText('OPEN')
    await page.reload()
    await expect(
      page.getByTitle(/^status: /),
      'Reopen did not persist across a reload.',
    ).toHaveText('OPEN')
    await expect(
      page.getByRole('list', { name: 'Lifecycle history for this failure pattern' }).getByText('Reopened manually'),
    ).toBeVisible()

    expect(patternUrl, 'Lost track of the pattern under test.').toBeTruthy()
  })

  test('unknown run id renders the 404 page rather than a blank shell', async ({ page }) => {
    // Error-path coverage. A signed-in user hitting a nonexistent run must get
    // the styled not-found page — not a blank shell, not a 500, and not an
    // unhandled exception from the Convex seam.
    const response = await page.goto('/runs/this-run-does-not-exist-e2e')
    expect(response?.status()).toBe(404)

    await expect(page.getByText('404', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: /page not found/i })).toBeVisible()

    // The diff page's own empty state is the other explicitly-designed
    // "nothing selected" path; assert it renders rather than a broken view.
    await page.goto('/diff')
    await expect(page.getByRole('heading', { level: 3, name: 'No runs selected' })).toBeVisible()
    await expect(page.getByLabel('Run A (left)')).toBeVisible()
    await expect(page.getByLabel('Run B (right)')).toBeVisible()
  })
})
