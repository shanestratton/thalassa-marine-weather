import { expect, type Page } from '@playwright/test';

/**
 * Tap the main navigation's Plan tab and wait for "Start plotting".
 *
 * A cold dev server can take longer than an action's timeout to boot the app
 * (the first test of a run, 2026-10-13: still "Loading Thalassa" after 15 s),
 * so the tab itself is waited for, then tapped once. The server can also
 * reload the page under that tap while it optimises newly seen dependencies
 * ("optimized dependencies changed. reloading"). Only a reload earns a second
 * tap: a tap that is simply swallowed, by an invisible layer or a lost first
 * click, still fails here, as it would fail a skipper (128-LIGHT review:
 * tapping again until the page came would have hidden that).
 */
export async function tapPlanTab(page: Page): Promise<void> {
    const nav = page.getByRole('navigation', { name: 'Main', exact: true });
    const show = page.getByRole('button', { name: /show navigation$/i });
    const plan = nav.getByRole('button', { name: 'Plan', exact: true });
    const start = page.getByRole('button', { name: 'Start plotting', exact: true });
    for (let attempt = 0; attempt < 3; attempt++) {
        await expect(plan.or(show).first(), 'the app is up, its navigation drawn').toBeVisible({ timeout: 60_000 });
        const reload = page.waitForEvent('load', { timeout: 25_000 });
        reload.catch(() => undefined);
        if (await show.isVisible().catch(() => false)) await show.click();
        await plan.click();
        const outcome = await Promise.race([
            start.waitFor({ state: 'visible', timeout: 25_000 }).then(
                () => 'shown' as const,
                () => 'missing' as const,
            ),
            reload.then(
                () => 'reloaded' as const,
                () => new Promise<never>(() => undefined),
            ),
        ]);
        if (outcome === 'shown') return;
        if (outcome === 'missing') break;
        await page.waitForLoadState('load');
    }
    await expect(start, 'one tap on Plan opens the Plan page').toBeVisible({ timeout: 1_000 });
}
