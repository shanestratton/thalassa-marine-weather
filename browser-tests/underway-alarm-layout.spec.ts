import { expect, test, type Page } from '@playwright/test';
import { ONBOARDED_STORAGE } from '../e2e/helpers/storageState';

/**
 * The under-way alarms (build 126, 126-02a), rendered for real in Chromium and
 * WebKit with wide fonts (Verdana on a Mac, DejaVu Sans on the Linux runner):
 *
 *  - a collision card, a shoal card and an off-route card stacked in that
 *    order, with the longest words each says (a draft-not-set shoal reading
 *    off a transducer; a muted off-route card; the strip's longest notices),
 *    fit 320x568 and 375x667: centred, clear of the tab bar, nothing cut off
 *    or sideways, every button a whole 44 pt target;
 *  - Settings → Preferences → Under-way alarms in the real app, under its real
 *    header: both switches and both selects whole, uncovered, nothing sideways
 *    (the selects 44 pt targets).
 *  - (126-02b) the watch check's card, a minute ahead, sounding and missed,
 *    last in the stack under a collision card (and the shoal and off-route
 *    cards, the worst case), fits the same sizes with its one 44 pt button;
 *    its Preferences switch and interval are whole and uncovered at 320x568.
 */

const SIZES = [
    { width: 320, height: 568 },
    { width: 375, height: 667 },
];

async function openFixture(page: Page, size: { width: number; height: number }, extra = '') {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(url.hostname) && route.request().method() === 'GET'
            ? route.continue()
            : route.abort();
    });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.setViewportSize(size);
    await page.goto(`/e2e/fixtures/underway-alarm.html?fonts=wide${extra}`);
    await page.evaluate(() => document.fonts.ready);
    return errors;
}

/** Each control: a whole 44 pt target, inside `box`, above the tab bar, and hit-testable. */
function controlIssues(page: Page, containerSelector: string) {
    return page.evaluate((selector) => {
        const issues: string[] = [];
        const container = document.querySelector<HTMLElement>(selector);
        if (!container) return [`no ${selector}`];
        const box = container.getBoundingClientRect();
        const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
        for (const button of container.querySelectorAll<HTMLElement>('button')) {
            button.scrollIntoView({ block: 'nearest' });
            const r = button.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            const name = button.getAttribute('aria-label') || button.textContent?.trim();
            if (r.height < 43.5 || r.width < 43.5) issues.push(`${name}: ${r.width}x${r.height}`);
            if (r.bottom > Math.min(box.bottom, nav.top) + 0.5 || r.top < box.top - 0.5) {
                issues.push(`${name} cannot be scrolled into the stack`);
                continue;
            }
            if (r.left < box.left - 0.5 || r.right > box.right + 0.5) issues.push(`${name} escapes sideways`);
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            if (!hit || !(hit === button || button.contains(hit))) issues.push(`${name} is covered`);
        }
        return issues;
    }, containerSelector);
}

function stackGeometry(page: Page) {
    return page.evaluate(() => {
        const stack = document.querySelector<HTMLElement>('[data-testid="ais-guard-stack"]')!;
        const box = stack.getBoundingClientRect();
        const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
        return {
            left: box.left,
            right: window.innerWidth - box.right,
            top: box.top,
            bottom: box.bottom,
            navTop: nav.top,
            sideways: [...stack.querySelectorAll<HTMLElement>('[role="alert"], [role="status"]')]
                .filter((card) => card.scrollWidth > card.clientWidth + 1)
                .map((card) => card.textContent?.slice(0, 30)),
            pageSideways: document.documentElement.scrollWidth > window.innerWidth + 1,
            zIndex: Number(getComputedStyle(stack).zIndex),
        };
    });
}

const settle = (page: Page) =>
    page.evaluate(() =>
        Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))),
    );

for (const size of SIZES) {
    for (const [name, extra] of [
        ['sounding', ''],
        ['muted, with the strip', '&muted=1&notices=1'],
    ] as const) {
        test(`collision, shoal and off-route cards (${name}) fit ${size.width}x${size.height} with wide fonts`, async ({
            page,
        }, info) => {
            const errors = await openFixture(page, size, extra);
            const cards = page.getByRole('alert');
            await expect(cards).toHaveCount(3);
            await settle(page);
            await expect(cards.nth(0)).toContainText('CLOSE QUARTERS');
            await expect(cards.nth(1)).toContainText('SHOAL WATER');
            await expect(cards.nth(1)).toContainText('about 0.2 m under the keel');
            await expect(cards.nth(1)).toContainText('below the transducer, taken as at the waterline');
            await expect(cards.nth(1)).toContainText('draft not set: set it in Vessel');
            await expect(cards.nth(2)).toContainText('OFF ROUTE');
            await expect(cards.nth(2)).toContainText('0.40 NM off the line');
            if (extra.includes('muted')) {
                await expect(cards.nth(2)).toContainText(/Muted until \d{2}:\d{2}/);
                await expect(page.getByRole('status')).toHaveCount(2);
            } else {
                await expect(page.getByRole('button', { name: 'Mute the off-route alarm for 30 minutes' })).toHaveCount(
                    1,
                );
            }
            await expect(page.getByRole('button', { name: 'Acknowledge the shoal alarm' })).toHaveCount(1);

            const geometry = await stackGeometry(page);
            expect(Math.abs(geometry.left - geometry.right), 'centred across').toBeLessThanOrEqual(1);
            expect(geometry.top).toBeGreaterThanOrEqual(0);
            expect(geometry.bottom, 'clear of the tab bar').toBeLessThanOrEqual(geometry.navTop + 0.5);
            expect(geometry.sideways).toEqual([]);
            expect(geometry.pageSideways).toBe(false);
            // Sounding: above the night tint, under the anchor alarm's critical layer.
            expect(geometry.zIndex).toBeGreaterThan(9000);
            expect(geometry.zIndex).toBeLessThan(2147483000);
            expect(await controlIssues(page, '[data-testid="ais-guard-stack"]')).toEqual([]);
            expect(errors).toEqual([]);

            if (size.width === 320) {
                await page.evaluate(() =>
                    document.querySelector('[data-testid="ais-guard-stack"]')!.scrollTo({ top: 0 }),
                );
                const path = info.outputPath(
                    `underway-cards-${extra ? 'muted' : 'sounding'}-${info.project.name}-320x568.png`,
                );
                await page.screenshot({ path, animations: 'disabled' });
                await info.attach(`underway-cards-${extra ? 'muted' : 'sounding'}-320x568`, {
                    path,
                    contentType: 'image/png',
                });
            }
        });
    }
}

for (const size of SIZES) {
    for (const watch of ['warning', 'sounding', 'missed'] as const) {
        test(`the watch check (${watch}) fits ${size.width}x${size.height} under a collision card with wide fonts`, async ({
            page,
        }, info) => {
            const errors = await openFixture(page, size, `&watch=${watch}`);
            const card = page.locator('[data-underway="watch-check"]');
            await expect(card).toHaveCount(1);
            await settle(page);
            await expect(card).toContainText('WATCH CHECK');
            if (watch === 'warning') {
                await expect(card).toHaveAttribute('role', 'status');
                await expect(card).toContainText('Watch check in 1 min');
                await expect(card).toContainText('Every 20 min while the track records.');
                await expect(page.getByRole('alert')).toHaveCount(3);
            } else {
                await expect(card).toHaveAttribute('role', 'alert');
                await expect(card).toContainText(
                    watch === 'missed' ? /Missed watch check at \d{1,2}:\d{2}/ : "Tap I'm on watch",
                );
                await expect(page.getByRole('alert')).toHaveCount(4);
            }
            await expect(card.getByRole('button', { name: "I'm on watch" })).toHaveCount(1);
            await expect(page.getByRole('status').filter({ hasText: 'iOS did not book' })).toHaveCount(1);
            // Last of the cards: after the collision card, the shoal card and the off-route card.
            const order = await page.evaluate(() =>
                [...document.querySelectorAll<HTMLElement>('[data-testid="ais-guard-stack"] [role]')]
                    .filter((el) => el.getAttribute('role') === 'alert' || el.dataset.underway)
                    .map(
                        (el) => el.dataset.underway ?? (el.textContent?.includes('CLOSE QUARTERS') ? 'collision' : '?'),
                    ),
            );
            expect(order).toEqual(['collision', 'shoal', 'off-route', 'watch-check']);

            const geometry = await stackGeometry(page);
            expect(Math.abs(geometry.left - geometry.right), 'centred across').toBeLessThanOrEqual(1);
            expect(geometry.top).toBeGreaterThanOrEqual(0);
            expect(geometry.bottom, 'clear of the tab bar').toBeLessThanOrEqual(geometry.navTop + 0.5);
            expect(geometry.sideways).toEqual([]);
            expect(geometry.pageSideways).toBe(false);
            expect(await controlIssues(page, '[data-testid="ais-guard-stack"]')).toEqual([]);
            expect(errors).toEqual([]);

            if (size.width === 320) {
                await card.evaluate((element) => element.scrollIntoView({ block: 'nearest' }));
                const path = info.outputPath(`watch-check-${watch}-${info.project.name}-320x568.png`);
                await page.screenshot({ path, animations: 'disabled' });
                await info.attach(`watch-check-${watch}-320x568`, { path, contentType: 'image/png' });
            }
        });
    }
}

test.describe('Settings → Preferences → Under-way alarms, in the real app', () => {
    test.use({
        serviceWorkers: 'block',
        storageState: async ({ baseURL }, provide) => {
            await provide({
                ...ONBOARDED_STORAGE,
                origins: ONBOARDED_STORAGE.origins.map((origin) => ({ ...origin, origin: new URL(baseURL!).origin })),
            });
        },
    });

    test('fits 320x568 with wide fonts under the real header', async ({ page, baseURL }, info) => {
        const size = { width: 320, height: 568 };
        await page.setViewportSize(size);
        const origin = new URL(baseURL!).origin;
        await page.route('**/*', (route) =>
            new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
        );
        await page.routeWebSocket('**/*', (socket) => socket.close());
        await page.addInitScript(() => {
            localStorage.setItem('thalassa_split_view', '0');
            document.addEventListener('DOMContentLoaded', () => {
                const wide = document.createElement('style');
                wide.textContent = ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; }";
                document.head.append(wide);
            });
        });
        await page.goto('/?view=vessel');
        await page.getByRole('button', { name: 'Settings', exact: true }).click({ timeout: 25_000 });
        await page.getByRole('button', { name: /^Open Preferences settings/ }).click();
        const heading = page.getByRole('heading', { name: 'Under-way alarms' });
        await expect(heading).toBeVisible({ timeout: 15_000 });

        // The selects are whole 44 pt targets. The switches are the shared
        // Settings Toggle (SettingsPrimitives.tsx), drawn the same for every
        // switch in Preferences: whole, uncovered and on the screen is what
        // this package can promise of them.
        for (const [control, minHeight] of [
            [page.getByRole('switch', { name: 'Off-route alarm' }), 24],
            [page.getByLabel('Off route inshore', { exact: true }), 43.5],
            [page.getByLabel('Off route offshore', { exact: true }), 43.5],
            [page.getByRole('switch', { name: 'Shoal alarm' }), 24],
            // 126-02b: the watch check's switch and interval.
            [page.getByRole('switch', { name: 'Watch check' }), 24],
            [page.getByLabel('Watch check every', { exact: true }), 43.5],
        ] as const) {
            await control.evaluate((element) => element.scrollIntoView({ block: 'center' }));
            await expect
                .poll(() =>
                    control.evaluate((element) => {
                        const r = element.getBoundingClientRect();
                        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                        return !!hit && (hit === element || element.contains(hit));
                    }),
                )
                .toBe(true);
            const box = (await control.boundingBox())!;
            expect(box.height, 'tall enough to hit').toBeGreaterThanOrEqual(minHeight);
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(size.width + 0.5);
        }
        await expect(page.getByRole('switch', { name: 'Off-route alarm' })).toHaveAttribute('aria-checked', 'true');
        await expect(page.getByRole('switch', { name: 'Shoal alarm' })).toHaveAttribute('aria-checked', 'true');
        await expect(page.getByLabel('Off route inshore', { exact: true })).toHaveValue('0.25');
        await expect(page.getByLabel('Off route offshore', { exact: true })).toHaveValue('1');
        await expect(page.getByRole('switch', { name: 'Watch check' })).toHaveAttribute('aria-checked', 'false');
        await expect(page.getByLabel('Watch check every', { exact: true })).toHaveValue('15');
        expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
        const card = heading.locator('xpath=following-sibling::*[1]');
        expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        await expect(card).toContainText('Margin under the keel: 0.5 m');

        await heading.scrollIntoViewIfNeeded();
        const path = info.outputPath(`underway-preferences-${info.project.name}-320x568.png`);
        await page.screenshot({ path, animations: 'disabled' });
        await info.attach('underway-preferences-320x568', { path, contentType: 'image/png' });
    });
});
