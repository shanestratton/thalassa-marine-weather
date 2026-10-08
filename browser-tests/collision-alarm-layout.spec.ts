import { expect, test, type Page } from '@playwright/test';
import { ONBOARDED_STORAGE } from '../e2e/helpers/storageState';

/**
 * The collision alarm (build 125, 125-01), rendered for real in Chromium and
 * WebKit with wide fonts (Verdana on a Mac, DejaVu Sans on the Linux runner):
 *
 *  - the card stack (close quarters, network DANGER, a lost contact, a
 *    guard-ring entry and the 'blind' notice, or the longest notice) fits
 *    320x568 and 375x667: centred, clear of the tab bar, nothing cut off or
 *    sideways, every button a whole 44 pt target;
 *  - the sound check the shield opens fits the same, centred above the tab
 *    bar with its Start button reachable;
 *  - Settings → Preferences → Collision alarm in the real app, under its real
 *    header: four whole 44 pt selects, uncovered, nothing sideways.
 */

const SIZES = [
    { width: 320, height: 568 },
    { width: 375, height: 667 },
];

async function openFixture(page: Page, size: { width: number; height: number }, view = '', notice = '') {
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
    await page.goto(
        `/e2e/fixtures/collision-alarm.html?fonts=wide${view ? `&view=${view}` : ''}${notice ? `&notice=${notice}` : ''}`,
    );
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
            const r = button.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            const name = button.getAttribute('aria-label') || button.textContent?.trim();
            if (r.height < 43.5 || r.width < 43.5) issues.push(`${name}: ${r.width}x${r.height}`);
            if (r.bottom > Math.min(box.bottom, nav.top) + 0.5 || r.top < box.top - 0.5) continue; // scrolled out
            if (r.left < box.left - 0.5 || r.right > box.right + 0.5) issues.push(`${name} escapes sideways`);
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            if (!hit || !(hit === button || button.contains(hit))) issues.push(`${name} is covered`);
        }
        return issues;
    }, containerSelector);
}

const NOTICES = {
    blind: 'Collision watch blind: no AIS for 60 s',
    // The longest the strip can say.
    unchecked: 'Collision alarm off until its sound check: turn the shield off and on again to run it',
} as const;

for (const size of SIZES) {
    for (const [notice, noticeText] of Object.entries(NOTICES)) {
        test(`the alarm cards and the ${notice} notice fit ${size.width}x${size.height} with wide fonts`, async ({
            page,
        }, info) => {
            const errors = await openFixture(page, size, '', notice);
            await expect(page.getByRole('status')).toHaveText(noticeText);
            const cards = page.getByRole('alert');
            await expect(cards).toHaveCount(4);
            // The cards scale in (guardAlertIn, 400 ms): measure where they come to rest.
            await page.evaluate(() =>
                Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))),
            );
            await expect(cards.nth(0)).toContainText('CLOSE QUARTERS');
            await expect(cards.nth(0)).toContainText('FICTIONAL CONTAINER CARRIER');
            await expect(cards.nth(0)).toContainText('CPA 0.04 NM in 1 min');
            await expect(cards.nth(1)).toContainText('internet AIS, 4 min old');
            // A lost contact: CPA unknown, its reason and its last CPA; never 'passed'.
            await expect(cards.nth(2)).toContainText('COLLISION RISK: CPA UNKNOWN');
            await expect(cards.nth(2)).toContainText('CPA unknown: her last report is over 10 min old');
            await expect(cards.nth(2)).toContainText('last CPA 0.12 NM in 7 min, 2 min ago');
            await expect(cards.nth(3)).toContainText('— kts');
            await expect(
                page.getByRole('button', { name: 'Acknowledge close quarters with FICTIONAL CONTAINER CARRIER' }),
            ).toBeVisible();

            const geometry = await page.evaluate(() => {
                const stack = document.querySelector<HTMLElement>('[data-testid="ais-guard-stack"]')!;
                const box = stack.getBoundingClientRect();
                const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
                const sideways = [...stack.querySelectorAll<HTMLElement>('[role="alert"], [role="status"]')]
                    .filter((card) => card.scrollWidth > card.clientWidth + 1)
                    .map((card) => card.textContent?.slice(0, 30));
                return {
                    left: box.left,
                    right: window.innerWidth - box.right,
                    top: box.top,
                    bottom: box.bottom,
                    navTop: nav.top,
                    sideways,
                    pageSideways: document.documentElement.scrollWidth > window.innerWidth + 1,
                    zIndex: Number(getComputedStyle(stack).zIndex),
                };
            });
            expect(Math.abs(geometry.left - geometry.right), 'centred across').toBeLessThanOrEqual(1);
            expect(geometry.top).toBeGreaterThanOrEqual(0);
            expect(geometry.bottom, 'clear of the tab bar').toBeLessThanOrEqual(geometry.navTop + 0.5);
            expect(geometry.sideways).toEqual([]);
            expect(geometry.pageSideways).toBe(false);
            // A sounding alarm sits above the night tint (but under the anchor alarm's critical layer).
            expect(geometry.zIndex).toBeGreaterThan(9000);
            expect(geometry.zIndex).toBeLessThan(2147483000);
            expect(await controlIssues(page, '[data-testid="ais-guard-stack"]')).toEqual([]);
            expect(errors).toEqual([]);

            if (size.width === 320) {
                const path = info.outputPath(`collision-cards-${notice}-${info.project.name}-320x568.png`);
                await page.screenshot({ path, animations: 'disabled' });
                await info.attach(`collision-cards-${notice}-320x568`, { path, contentType: 'image/png' });
            }
        });
    }

    test(`the collision sound check fits ${size.width}x${size.height}, centred above the tab bar`, async ({
        page,
    }, info) => {
        const errors = await openFixture(page, size, 'check');
        const dialog = page.getByRole('dialog', { name: 'Sound check' });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText('Before the collision watch starts');
        await expect(dialog).toContainText('Start collision watch');
        const geometry = await dialog.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
            return {
                left: box.left,
                right: window.innerWidth - box.right,
                top: box.top,
                bottom: box.bottom,
                navTop: nav.top,
                viewport: window.innerHeight,
                sideways: element.scrollWidth > element.clientWidth + 1,
            };
        });
        expect(Math.abs(geometry.left - geometry.right), 'centred across').toBeLessThanOrEqual(1);
        expect(geometry.top).toBeGreaterThanOrEqual(0);
        expect(geometry.bottom, 'clear of the tab bar').toBeLessThanOrEqual(geometry.navTop + 0.5);
        // Centred in the band above the tab bar (within the backdrop's 1.5rem padding).
        expect(Math.abs(geometry.top - (geometry.navTop - geometry.bottom))).toBeLessThanOrEqual(1.5);
        expect(geometry.sideways).toBe(false);
        // Its actions stay whole and reachable; the checklist scrolls inside it.
        const start = page.getByRole('button', { name: 'Confirm selection' });
        await expect(start).toBeInViewport({ ratio: 1 });
        const startBox = (await start.boundingBox())!;
        expect(startBox.height).toBeGreaterThanOrEqual(43.5);
        expect(errors).toEqual([]);
        if (size.width === 320) {
            const path = info.outputPath(`collision-sound-check-${info.project.name}-320x568.png`);
            await page.screenshot({ path, animations: 'disabled' });
            await info.attach('collision-sound-check-320x568', { path, contentType: 'image/png' });
        }
    });
}

test.describe('Settings → Preferences → Collision alarm, in the real app', () => {
    test.use({
        serviceWorkers: 'block',
        storageState: async ({ baseURL }, provide) => {
            await provide({
                ...ONBOARDED_STORAGE,
                origins: ONBOARDED_STORAGE.origins.map((origin) => ({ ...origin, origin: new URL(baseURL!).origin })),
            });
        },
    });

    for (const size of SIZES) {
        test(`fits ${size.width}x${size.height} with wide fonts under the real header`, async ({
            page,
            baseURL,
        }, info) => {
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
            const heading = page.getByRole('heading', { name: 'Collision alarm' });
            await expect(heading).toBeVisible({ timeout: 15_000 });

            for (const label of ['Offshore CPA', 'Offshore TCPA', 'Inshore CPA', 'Inshore TCPA']) {
                const select = page.getByLabel(label, { exact: true });
                await select.scrollIntoViewIfNeeded();
                await select.evaluate((element) => element.scrollIntoView({ block: 'center' }));
                await expect
                    .poll(() =>
                        select.evaluate((element) => {
                            const r = element.getBoundingClientRect();
                            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                            return !!hit && (hit === element || element.contains(hit));
                        }),
                    )
                    .toBe(true);
                const box = (await select.boundingBox())!;
                expect(box.height, `${label} is a 44 pt target`).toBeGreaterThanOrEqual(43.5);
                expect(box.x).toBeGreaterThanOrEqual(0);
                expect(box.x + box.width).toBeLessThanOrEqual(size.width + 0.5);
            }
            await expect(page.getByLabel('Offshore CPA', { exact: true })).toHaveValue('0.5');
            await expect(page.getByLabel('Inshore TCPA', { exact: true })).toHaveValue('6');
            expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
            const card = heading.locator('xpath=following-sibling::*[1]');
            expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);

            if (size.width === 320) {
                await heading.scrollIntoViewIfNeeded();
                const path = info.outputPath(`collision-preferences-${info.project.name}-320x568.png`);
                await page.screenshot({ path, animations: 'disabled' });
                await info.attach('collision-preferences-320x568', { path, contentType: 'image/png' });
            }
        });
    }
});
