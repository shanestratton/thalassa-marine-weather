import { expect, test, type Locator, type Page } from '@playwright/test';
import { applyWideFonts, expectWideFaceDrawn } from '../e2e/helpers/wideFonts';

/**
 * The Galley scrolls clear of the tab bar (126-B1, binder audit GAL-01).
 *
 * "Open shopping list" is the only way into the grocery list. With two active
 * meals on a phone it sat under the tab bar at the bottom of the scroll and
 * could not be tapped, and the last Saved recipes card was clipped the same
 * way: the scroller padded 16 px where every binder sibling clears the bar.
 *
 * The real GalleyPage and index.css under a copy of the app's header and tab
 * bar (e2e/fixtures/galley-scroll.tsx), in wide fonts (Verdana on a Mac,
 * DejaVu Sans on the Linux runner). At the bottom of the scroll, the button and
 * the last recipe card end at least 8 px above the tab bar, a tap at their
 * centre lands on them, and nothing scrolls sideways.
 */

const SIZES = [
    { name: '320x568', width: 320, height: 568 },
    { name: '390x844', width: 390, height: 844 },
    { name: '430x932', width: 430, height: 932 },
];

async function open(page: Page, size: { width: number; height: number }, tab: 'active' | 'recipes') {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(url.hostname) && route.request().method() === 'GET'
            ? route.continue()
            : route.abort();
    });
    await applyWideFonts(page);
    await page.setViewportSize(size);
    await page.goto(`/e2e/fixtures/galley-scroll.html?tab=${tab}`);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByTestId('app-header')).toBeVisible({ timeout: 25_000 });
    return errors;
}

/** Scroll the target's scroller to its very end, as a thumb would. */
async function scrollToEnd(target: Locator) {
    await target.evaluate((element) => {
        let scroller: HTMLElement | null = element.parentElement;
        while (
            scroller &&
            !(
                scroller.scrollHeight > scroller.clientHeight + 1 &&
                /(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
            )
        )
            scroller = scroller.parentElement;
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    await target
        .page()
        .evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** Whole, above the bar with room to spare, and the one a tap at its centre reaches. */
async function expectClearOfTabBar(target: Locator, what: string) {
    await scrollToEnd(target);
    const m = await target.evaluate((element) => {
        const r = element.getBoundingClientRect();
        const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
            top: r.top,
            bottom: r.bottom,
            navTop: nav.top,
            hitIsTarget: !!hit && (hit === element || element.contains(hit)),
        };
    });
    expect(m.top, `${what} is on screen`).toBeGreaterThanOrEqual(0);
    expect(m.bottom, `${what} ends at least 8 px above the tab bar`).toBeLessThanOrEqual(m.navTop - 8);
    expect(m.hitIsTarget, `a tap on ${what} reaches it, not the tab bar`).toBe(true);
}

async function expectNothingSideways(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
}

for (const size of SIZES) {
    test(`Galley at ${size.name}: "Open shopping list" scrolls clear of the tab bar`, async ({ page }) => {
        const errors = await open(page, size, 'active');
        await expect(page.getByText('Kedgeree')).toBeVisible();
        await expect(page.getByText('Lentil dal')).toBeVisible();
        const button = page.getByRole('button', { name: /^Open shopping list, 3 items remaining$/ });
        await expect(button).toBeAttached();
        await expectWideFaceDrawn(button);
        await expectClearOfTabBar(button, 'Open shopping list');
        await expectNothingSideways(page);
        expect(errors).toEqual([]);
    });

    test(`Galley at ${size.name}: the last saved recipe scrolls clear of the tab bar`, async ({ page }) => {
        const errors = await open(page, size, 'recipes');
        await expect(page.getByRole('tab', { name: /Saved recipes/ })).toHaveAttribute('aria-selected', 'true');
        // Ten recipes: the eight in the library and the two the meals saved.
        await expect(page.getByText('Pancakes at anchor')).toBeAttached();
        const cards = page.locator('#galley-recipes-panel > div').filter({ hasText: /ingredients/ });
        await expect(cards).toHaveCount(10);
        const lastCard = cards.last();
        await expectClearOfTabBar(lastCard, 'the last recipe card');
        await expectNothingSideways(page);
        expect(errors).toEqual([]);
    });
}
