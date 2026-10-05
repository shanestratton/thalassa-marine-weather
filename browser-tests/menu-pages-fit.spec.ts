/**
 * Menu pages fit one screen, and the split-pane front doors fit their pane.
 *
 * Shane 2026-10-04: "the route planner front page does not fit its screen when
 * in split screen mode, same with the log screen (albeit it is just the cta
 * button i little low). also the vessel page needs to have one box around crew
 * and float plan, boat binder, settings, nmea gateway, boat network, and music"
 * and "i would like to ensure that the vessel page all fits on one screen
 * without needing to scroll, as i prefer that all of the menu itemed pages fit
 * into one screen".
 *
 * The real app, against source, with wide fonts (Verdana on a Mac, DejaVu Sans
 * on the Linux runner) so a Mac run wraps text the way CI does. A browser has
 * no notch: the "+insets" sizes take the iPhone's status bar and home
 * indicator off the viewport (the header pads max(1rem, top inset), the tab
 * bar adds the bottom inset), so 393x775 is a 6.1-inch Pro's page and 375x662
 * an SE's. No account, no backend: every request off this origin is refused.
 */
import { expect, test, type Page } from '@playwright/test';
import { ONBOARDED_STORAGE } from '../e2e/helpers/storageState';

test.use({
    serviceWorkers: 'block',
    storageState: async ({ baseURL }, provide) => {
        await provide({
            ...ONBOARDED_STORAGE,
            origins: ONBOARDED_STORAGE.origins.map((origin) => ({ ...origin, origin: new URL(baseURL!).origin })),
        });
    },
});

interface Open {
    width: number;
    height: number;
    view?: 'vessel' | 'voyage';
    split?: boolean;
    mode?: 'dark' | 'light' | 'night';
    /** A saved two-leg trip and a route, so the Plan page shows its Trip box. */
    trip?: boolean;
}

async function open(
    page: Page,
    baseURL: string | undefined,
    { width, height, view, split = false, mode = 'dark', trip = false }: Open,
) {
    await page.setViewportSize({ width, height });
    const origin = new URL(baseURL!).origin;
    await page.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.addInitScript(
        ({ split, mode, trip }) => {
            localStorage.setItem('thalassa_split_view', split ? '1' : '0');
            for (const key of [
                'thalassa_settings_mirror::anonymous',
                'CapacitorStorage.thalassa_settings::anonymous',
            ]) {
                const saved = JSON.parse(localStorage.getItem(key)!);
                saved.settings.displayMode = mode;
                localStorage.setItem(key, JSON.stringify(saved));
            }
            if (trip) {
                const at = new Date().toISOString();
                const leg = (id: string, name: string, from: number, to: number, ordinal?: number) => ({
                    id,
                    name,
                    createdAt: at,
                    points: [
                        { lat: -27.1 - from / 10, lon: 153.1 + from / 10 },
                        { lat: -27.1 - to / 10, lon: 153.1 + to / 10 },
                    ],
                    ...(ordinal ? { tripId: 'fixture-trip', legOrdinal: ordinal } : {}),
                });
                localStorage.setItem(
                    'thalassa_traced_routes_v1::anonymous',
                    JSON.stringify([
                        leg('fixture-trip', 'Harbour - Bay Point', 0, 1, 1),
                        leg('fixture-leg-2', 'Bay Point - Sandy Cove (2nd Leg)', 1, 2, 2),
                        leg('fixture-route', 'Marina - Island Anchorage', 3, 4),
                    ]),
                );
            }
            document.addEventListener('DOMContentLoaded', () => {
                const wide = document.createElement('style');
                wide.textContent = ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; }";
                document.head.append(wide);
            });
        },
        { split, mode, trip },
    );
    await page.goto(view ? `/?view=${view}` : '/');
}

async function settle(page: Page) {
    // Twice: a page transition can start a frame after the page has mounted.
    for (let pass = 0; pass < 2; pass++) {
        await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            // The page's own entrances only: in split view the Glass pane beside it
            // keeps animations of its own that never finish.
            const scope = document.querySelector('[data-split-pane="page"]') ?? document.querySelector('#main-content');
            const finite = (scope?.getAnimations({ subtree: true }) ?? []).filter(
                (animation) => animation.effect?.getComputedTiming().iterations !== Infinity,
            );
            await Promise.race([
                Promise.all(finite.map((animation) => animation.finished.catch(() => undefined))),
                new Promise((resolve) => setTimeout(resolve, 3_000)),
            ]);
        });
    }
}

/** Where the page must end: the tab bar's top, the pane's bottom, or (in phone
 *  landscape, where the tab bar gives way to a toggle) the screen's. */
async function floor(page: Page) {
    return page.evaluate(() => {
        const pane = document.querySelector('[data-split-pane="page"]');
        if (pane) return pane.getBoundingClientRect().bottom;
        const bar = document.querySelector('nav[aria-label="Main"] > div.h-16');
        return bar ? bar.getBoundingClientRect().top : window.innerHeight;
    });
}

/** Every listed control is on screen, whole, not covered, and 44 pt tall. */
async function wholeRows(page: Page, selector: string, limit: number) {
    const measure = () =>
        page.locator(selector).evaluateAll((elements) =>
            elements.map((element) => {
                const box = element.getBoundingClientRect();
                const hits = [box.top + 3, box.top + box.height / 2, box.bottom - 3].every((y) => {
                    const hit = document.elementFromPoint(box.left + box.width / 3, y);
                    return !!hit && (hit === element || element.contains(hit));
                });
                return {
                    name: element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 30),
                    top: box.top,
                    bottom: box.bottom,
                    height: box.height,
                    hits,
                };
            }),
        );
    // A row still sliding in with its page is not yet where it rests.
    await expect.poll(async () => (await measure()).every((row) => row.hits), { timeout: 5_000 }).toBe(true);
    const rows = await measure();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
        expect(row.height, `${row.name} is a 44 pt target`).toBeGreaterThanOrEqual(44 - 0.5);
        expect(row.bottom, `${row.name} ends above the tab bar / pane edge`).toBeLessThanOrEqual(limit + 0.5);
        expect(row.hits, `${row.name} is not covered`).toBe(true);
    }
    return rows;
}

/** The page's own scroller does not scroll. */
async function noScroll(page: Page, selector: string) {
    const overflow = await page.locator(selector).evaluate((element) => {
        const scroller = getComputedStyle(element).display === 'contents' ? element.parentElement! : element;
        return scroller.scrollHeight - scroller.clientHeight;
    });
    expect(overflow, `${selector} scrolls by ${overflow}px`).toBeLessThanOrEqual(1);
}

/** The page fills its screen (Shane 2026-10-04: "make the whole thing take up
 *  the enitre page"): the menu box runs down to the floor, ending the port's
 *  pb-2 and the root's 8 px above it, not a dead band of empty page. */
async function filled(page: Page, limit: number) {
    const box = (await page.getByTestId('vessel-hub-menu').boundingBox())!;
    const gap = limit - (box.y + box.height);
    expect(gap, `the menu box ends ${gap}px above the floor`).toBeGreaterThanOrEqual(-0.5);
    expect(gap, `the menu box ends ${gap}px above the floor`).toBeLessThanOrEqual(17);
}

const MENU_ROWS = '[data-testid="vessel-hub-menu"] > button';
const ORDER = ['Crew & Float Plan', 'Boat Binder', 'NMEA Gateway', 'Music', 'Settings', 'Boat Network'];

const PHONES = [
    { name: 'SE', width: 375, height: 667 },
    { name: 'SE +insets', width: 375, height: 662 },
    // A 6.1-inch iPhone at Display Zoom is 320x693; its zoomed insets (taken
    // here as 48 pt above, 34 below) are assumed, not read from a device.
    { name: '6.1in Display Zoom +insets', width: 320, height: 627 },
    { name: '13 mini +insets', width: 375, height: 743 },
    { name: '390x844', width: 390, height: 844 },
    { name: '6.1in Pro +insets', width: 393, height: 775 },
    { name: '430x932', width: 430, height: 932 },
    { name: 'Pro Max +insets', width: 430, height: 856 },
    // 956 less the 16 Pro Max's 62 pt status bar (46 above the header's 1rem)
    // and 34 pt home indicator: Settings' menu is ~718 px here, where its
    // 80 px run-off once scrolled 26 px of empty space.
    { name: '16 Pro Max +insets', width: 440, height: 876 },
];
const LANDSCAPE = [
    { name: 'SE landscape', width: 667, height: 375 },
    { name: '844x390 landscape', width: 844, height: 390 },
    { name: '932x430 landscape', width: 932, height: 430 },
];
// Split view needs 1024 pt. Shane's iPad is 1080x810; "+insets" takes its 24 pt
// status bar and 20 pt home indicator off (8 pt above the header's 1rem, 20 below).
const PANES = [
    { name: '1024x768 split', width: 1024, height: 768 },
    { name: '1080x810 split', width: 1080, height: 810 },
    { name: '1080x810 split +insets', width: 1080, height: 782 },
    { name: 'iPad mini split +insets', width: 1133, height: 716 },
    { name: '1366x1024 split', width: 1366, height: 1024 },
];

test.describe('Vessel page', () => {
    for (const size of [...PHONES, ...LANDSCAPE]) {
        test(`fits one screen, one menu box, at ${size.name}`, async ({ page, baseURL }) => {
            await open(page, baseURL, { ...size, view: 'vessel' });
            await expect(page.getByRole('button', { name: 'Open Diary', exact: true })).toBeVisible({
                timeout: 25_000,
            });
            await settle(page);
            await expect(page.getByTestId('vessel-hub-menu')).toHaveCount(1);
            expect(await page.locator(MENU_ROWS).evaluateAll((rows) => rows.map((row) => row.ariaLabel))).toEqual(
                ORDER,
            );
            await noScroll(page, '.vessel-hub-port');
            const limit = await floor(page);
            await wholeRows(page, MENU_ROWS, limit);
            await wholeRows(
                page,
                '[data-testid="vessel-safety-controls"] > button, .vessel-hub-tile, .skipper-device-action',
                limit,
            );
            if (size.width < size.height) await filled(page, limit);
            if (size.width > size.height) {
                // The left column stays clear of the bottom-left nav toggle.
                const toggle = await page.getByRole('button', { name: /show navigation/ }).boundingBox();
                const card = await page.getByTestId('skipper-device-card').boundingBox();
                expect(card!.y + card!.height).toBeLessThanOrEqual(toggle!.y);
            }
        });
    }

    for (const size of PANES) {
        test(`fits its pane at ${size.name}`, async ({ page, baseURL }) => {
            await open(page, baseURL, { ...size, view: 'vessel', split: true });
            await expect(page.getByRole('button', { name: 'Open Diary', exact: true })).toBeVisible({
                timeout: 25_000,
            });
            await settle(page);
            await noScroll(page, '.vessel-hub-port');
            const limit = await floor(page);
            await wholeRows(page, MENU_ROWS, limit);
            await filled(page, limit);
        });
    }

    for (const mode of ['light', 'night'] as const) {
        test(`fits in ${mode} at 6.1in Pro +insets`, async ({ page, baseURL }) => {
            await open(page, baseURL, { width: 393, height: 775, view: 'vessel', mode });
            await expect(page.getByRole('button', { name: 'Open Diary', exact: true })).toBeVisible({
                timeout: 25_000,
            });
            await settle(page);
            await noScroll(page, '.vessel-hub-port');
            const limit = await floor(page);
            await wholeRows(page, MENU_ROWS, limit);
            await filled(page, limit);
        });
    }

    test('320x568 (an SE at Display Zoom) still reaches every row by scrolling', async ({ page, baseURL }) => {
        // Known short: four 44 pt-minimum blocks, six 44 pt rows and the app
        // header need ~500 pt where 320x568 leaves ~430. Until the header and
        // skipper card get a one-row form, every row must at least scroll clear.
        await open(page, baseURL, { width: 320, height: 568, view: 'vessel' });
        await expect(page.getByRole('button', { name: 'Open Diary', exact: true })).toBeVisible({ timeout: 25_000 });
        await settle(page);
        await page.locator('.vessel-hub-port').evaluate((port) => port.scrollTo({ top: port.scrollHeight }));
        await expect
            .poll(async () => {
                const row = await page.getByRole('button', { name: 'Boat Network', exact: true }).boundingBox();
                return row!.y + row!.height;
            })
            .toBeLessThanOrEqual(await floor(page));
    });
});

test.describe('other menu pages', () => {
    for (const size of [...PHONES.filter((phone) => phone.width !== 430), ...PANES.slice(0, 3)]) {
        test(`Boat Binder fits at ${size.name}`, async ({ page, baseURL }) => {
            await open(page, baseURL, { ...size, view: 'vessel', split: size.width >= 1024 });
            await page.getByRole('button', { name: 'Boat Binder', exact: true }).click({ timeout: 25_000 });
            await expect(page.getByRole('heading', { level: 1, name: 'Boat Binder' })).toBeVisible();
            await settle(page);
            await noScroll(page, '.vessel-binder-port');
            await wholeRows(page, '.vessel-binder-port .hub-row', await floor(page));
        });

        test(`Settings menu fits at ${size.name}`, async ({ page, baseURL }) => {
            await open(page, baseURL, { ...size, view: 'vessel', split: size.width >= 1024 });
            await page.getByRole('button', { name: 'Settings', exact: true }).click({ timeout: 25_000 });
            await expect(page.getByRole('button', { name: /^Open Preferences settings/ })).toBeVisible();
            await settle(page);
            await noScroll(page, '.settings-menu-screen .thalassa-scroll-fade');
            await wholeRows(page, '.settings-menu-row', await floor(page));
        });
    }
});

test.describe('split-pane front doors', () => {
    for (const size of PANES) {
        test(`Route Planner front door fits its pane at ${size.name}`, async ({ page, baseURL }) => {
            await open(page, baseURL, { ...size, view: 'voyage', split: true, trip: true });
            await expect(page.locator('.route-planner-cta > div')).toBeVisible({ timeout: 25_000 });
            await expect(
                page.getByRole('combobox', { name: 'Trip · Legs: pick a trip or route to continue' }),
            ).toBeVisible();
            await settle(page);
            const pane = (await page.locator('[data-split-pane="page"]').boundingBox())!;
            const paneBottom = pane.y + pane.height - 1; // inside the frame's border
            const cta = (await page.locator('.route-planner-cta > div').boundingBox())!;
            // The iPhone's 8 pt above the tab bar becomes 8 pt above the pane's edge.
            expect(paneBottom - (cta.y + cta.height)).toBeGreaterThanOrEqual(6);
            expect(paneBottom - (cta.y + cta.height)).toBeLessThanOrEqual(10);
            // Every way in is whole above the CTA, the page's column scrolled
            // to its end if a short pane needs it: never parked beneath the
            // slide (browser-tests/plan-page-fit.spec.ts measures the fill).
            await page.locator('.route-planner-form').evaluate((form) => form.scrollTo({ top: form.scrollHeight }));
            for (const name of ['Saved routes', 'Past voyages', 'Plan Your Day']) {
                const box = (await page.getByRole('button', { name, exact: true }).boundingBox())!;
                expect(box.y, `${name} starts inside the pane`).toBeGreaterThanOrEqual(pane.y);
                expect(box.y + box.height, `${name} clears the CTA`).toBeLessThanOrEqual(cta.y + 0.5);
            }
        });
    }

    for (const size of [{ name: '390x844 phone', width: 390, height: 844 }, ...PANES]) {
        test(`Log's slide sits 8 pt above the bar or the pane at ${size.name}`, async ({ page, baseURL }) => {
            await open(page, baseURL, { ...size, split: size.width >= 1024 });
            await page
                .getByRole('navigation', { name: 'Main', exact: true })
                .getByRole('button', { name: 'Log', exact: true })
                .click({ timeout: 25_000 });
            const slide = page.getByRole('button', { name: 'Slide to Start Tracking' });
            await expect(slide).toBeVisible({ timeout: 25_000 });
            await settle(page);
            const box = (await slide.boundingBox())!;
            const limit = await floor(page);
            const gap = limit - (box.y + box.height);
            expect(gap, `slide gap ${gap}`).toBeGreaterThanOrEqual(6);
            expect(gap).toBeLessThanOrEqual(10);
        });
    }
});
