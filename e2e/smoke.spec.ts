import { expect, test } from '@playwright/test';

/**
 * M9 smoke test (Part 7.2): the full user journey.
 *
 * Requires:
 *   - a running Postgres with migrations applied,
 *   - live Wikipedia access,
 *   - a valid LLM provider key (the worker performs the extraction),
 *   - `NODE_ENV=test` so `/api/auth/test-login` is enabled.
 *
 * Run manually before deploying:
 *   pnpm exec playwright install chromium
 *   pnpm run e2e
 *
 * This is intentionally NOT part of CI (live calls, slow, costly).
 */

const TEST_EMAIL = 'test@example.com';

test('full user journey: sign in, search, create, expand, verify graph', async ({
  page,
}) => {
  // 1. Navigate to the app — unauthenticated users see the sign-in screen.
  await page.goto('/');
  await expect(page.locator('[data-testid="sign-in-button"]')).toBeVisible();

  // 2. Sign in via the test-only endpoint (avoids parsing the console magic
  //    link). `page.request` shares cookie storage with the browser context.
  const login = await page.request.post('/api/auth/test-login', {
    data: { email: TEST_EMAIL },
  });
  expect(login.ok()).toBeTruthy();

  // 3. Reload — now authenticated, the search view is shown.
  await page.goto('/');
  await expect(page.locator('[data-testid="search-input"]')).toBeVisible();

  // 4. Search for "Treaty of Versailles".
  await page.fill('[data-testid="search-input"]', 'Treaty of Versailles');
  await page.press('[data-testid="search-input"]', 'Enter');

  // 5. Wait for candidates and pick the first.
  await page.waitForSelector('[data-testid="candidate-card"]', {
    timeout: 30_000,
  });
  await page.locator('[data-testid="candidate-card"]').first().click();

  // 6. The graph renders with the root node.
  await page.waitForSelector('.react-flow__node', { timeout: 30_000 });
  await expect(page.locator('.react-flow__node').first()).toContainText(
    'Treaty of Versailles',
  );

  // 7. Expand upstream (causes). On a re-run against a populated database the
  //    root may already be expanded, in which case the control is disabled and
  //    the causes are already present.
  const expandUpstream = page.locator('[data-testid="expand-upstream"]').first();
  if (await expandUpstream.isEnabled()) {
    await expandUpstream.click();
  }

  // 8. Wait for the expansion to complete and new nodes to appear.
  await expect
    .poll(async () => page.locator('.react-flow__node').count(), {
      timeout: 180_000,
    })
    .toBeGreaterThan(1);

  // 9. Click a newly added node to open the side panel.
  await page.locator('.react-flow__node').nth(1).click();
  await expect(page.locator('[data-testid="side-panel"]')).toBeVisible();

  // 10. Select a connection to reveal its evidence card.
  const edgeLabel = page.locator('[data-testid="edge-label"]').first();
  if ((await edgeLabel.count()) > 0) {
    await edgeLabel.click();
    await expect(
      page.locator('[data-testid="evidence-card"]').first(),
    ).toBeVisible();
  }
});
