/**
 * The Plan tab's front door fits one screen, fills it, and keeps everything.
 *
 * Shane 2026-10-05: "the only screen i dont really like, is the planning, it
 * looks very messy. can you make it pop. cleaner. dont lose any information
 * from it. it just needs to look as nice as all of the other tier 1 screens.
 * all fitting on one page, organised, popping".
 *
 * The real app, against source, with fictional data only and wide fonts
 * (Verdana on a Mac, DejaVu Sans on the Linux runner) so a Mac run wraps text
 * the way CI does. Three states: nothing saved and leaving now; a passage
 * being planned (a saved two-leg trip, a route and tomorrow's 06:30
 * departure); and that plus no vessel profile (the default boat).
 * "+insets" sizes take the iPhone's status bar and home indicator off the
 * viewport, as in menu-pages-fit.spec.ts.
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

type State = 'empty' | 'planning' | 'full';

async function open(
    page: Page,
    baseURL: string | undefined,
    width: number,
    height: number,
    state: State,
    split = width >= 1024,
    /** A route library of the test's own (the Trip sheet), and a keyboard the
     *  test can raise ('test:keyboard', as keyboard-layout.spec.ts does). */
    extra: { traces?: unknown[]; keyboard?: boolean } = {},
) {
    await page.setViewportSize({ width, height });
    const origin = new URL(baseURL!).origin;
    await page.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.addInitScript(
        ({ split, state, traces, keyboard }) => {
            localStorage.setItem('thalassa_split_view', split ? '1' : '0');
            if (keyboard) {
                // No browser shows a mobile keyboard under automation. Model
                // the visual viewport the app's keyboard guard reads, and paint
                // the keyboard so hit-tests see it (e2e/fixtures/move-anchor.tsx).
                const viewport = new EventTarget();
                Object.assign(viewport, { height: window.innerHeight, offsetTop: 0, scale: 1 });
                Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
                const cover = document.createElement('div');
                Object.assign(cover.style, {
                    position: 'fixed',
                    bottom: '0',
                    left: '0',
                    right: '0',
                    height: '0',
                    display: 'none',
                    background: '#334155',
                    zIndex: '2147483647',
                });
                document.addEventListener('DOMContentLoaded', () => document.body.append(cover));
                window.addEventListener('test:keyboard', ((event: CustomEvent<number>) => {
                    Object.assign(viewport, { height: window.innerHeight - event.detail });
                    cover.style.height = `${event.detail}px`;
                    cover.style.display = event.detail ? 'block' : 'none';
                    viewport.dispatchEvent(new Event('resize'));
                }) as EventListener);
            }
            if (traces) {
                localStorage.setItem('thalassa_traced_routes_v1::anonymous', JSON.stringify(traces));
            } else if (state !== 'empty') {
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
            if (state !== 'empty') {
                const tomorrow = new Date();
                tomorrow.setDate(tomorrow.getDate() + 1);
                tomorrow.setHours(6, 30, 0, 0);
                sessionStorage.setItem('thalassa_trace_departure_ms::anonymous', String(tomorrow.getTime()));
            }
            document.addEventListener('DOMContentLoaded', () => {
                const wide = document.createElement('style');
                wide.textContent = ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; }";
                document.head.append(wide);
            });
        },
        { split, state, traces: extra.traces ?? null, keyboard: !!extra.keyboard },
    );
    await page.goto('/?view=voyage');
    await expect(page.getByRole('button', { name: 'Start plotting', exact: true })).toBeVisible({ timeout: 25_000 });
    if (state === 'full') {
        // A stored settings blob always hydrates a vessel object, so the
        // default-vessel state (no profile, "Personalise →") is set in the
        // running store, as a fresh install starts.
        await page.evaluate(async () => {
            // The dev server's own module instance, the one the app imported.
            const url = '/stores/settingsStore.ts';
            const { useSettingsStore } = (await import(
                /* @vite-ignore */ url
            )) as typeof import('../stores/settingsStore');
            const settings = useSettingsStore.getState().settings;
            useSettingsStore.setState({ settings: { ...settings, vessel: undefined } });
        });
        await expect(page.getByRole('button', { name: 'Personalise vessel profile in Settings' })).toBeVisible();
    }
    await settle(page);
}

async function settle(page: Page) {
    for (let pass = 0; pass < 2; pass++) {
        await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
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

/** The page's floor: the tab bar's top, or the pane's bottom. */
async function floor(page: Page) {
    return page.evaluate(() => {
        const pane = document.querySelector('[data-split-pane="page"]');
        if (pane) return pane.getBoundingClientRect().bottom;
        const bar = document.querySelector('nav[aria-label="Main"] > div.h-16');
        return bar ? bar.getBoundingClientRect().top : window.innerHeight;
    });
}

const PHONES = [
    { name: '390x844', width: 390, height: 844 },
    { name: 'SE', width: 375, height: 667 },
    { name: 'SE +insets', width: 375, height: 662 },
    { name: '320x568', width: 320, height: 568 },
    { name: '6.1in Display Zoom +insets', width: 320, height: 627 },
    { name: '6.1in Pro +insets', width: 393, height: 775 },
    { name: '430x932', width: 430, height: 932 },
];
const PANES = [
    { name: '1024x768 split', width: 1024, height: 768 },
    { name: '1080x810 split', width: 1080, height: 810 },
    { name: '1080x810 split +insets', width: 1080, height: 782 },
    { name: 'iPad mini split +insets', width: 1133, height: 716 },
];
const STATES: State[] = ['empty', 'planning', 'full'];
// Phone landscape: the tab bar gives way to a toggle, and the page sits in
// the view's scroller with the CTA sticky at its foot.
const LANDSCAPE = [
    { name: '844x390 landscape', width: 844, height: 390 },
    { name: '932x430 landscape', width: 932, height: 430 },
    { name: 'SE landscape', width: 667, height: 375 },
];

test.describe('Plan front door fits and fills its screen', () => {
    for (const state of STATES) {
        for (const size of [...PHONES, { name: 'iPad portrait', width: 768, height: 1024 }, ...PANES]) {
            test(`${state} at ${size.name}`, async ({ page, baseURL }) => {
                await open(page, baseURL, size.width, size.height, state);
                const limit = await floor(page);
                const m = await page.evaluate(() => {
                    const form = document.querySelector<HTMLElement>('.route-planner-form')!;
                    const view = document.querySelector('.route-planner-page')!.parentElement!;
                    const grid = document.querySelector('.plan-doors')!.getBoundingClientRect();
                    const cta = document.querySelector('.route-planner-cta > div')!.getBoundingClientRect();
                    const reserveTop =
                        form.getBoundingClientRect().bottom - parseFloat(getComputedStyle(form).paddingBottom);
                    const date = document.querySelector<HTMLInputElement>('input[aria-label="Departure date"]')!;
                    // The hour and the minutes fill their pill: a tap at any of
                    // its corners lands on a select.
                    const pill = document.querySelector('.plan-depart-time')!.getBoundingClientRect();
                    const selects = [...document.querySelectorAll('.plan-depart-time select')].map((select) => {
                        const box = select.getBoundingClientRect();
                        return { width: box.width, height: box.height };
                    });
                    const corners = [
                        [pill.left + 2, pill.top + 1],
                        [pill.left + 2, pill.bottom - 1],
                        [pill.right - 2, pill.top + 1],
                        [pill.right - 2, pill.bottom - 1],
                    ].map(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? null);
                    const tiles = [...document.querySelectorAll<HTMLElement>('.plan-tile')].map((tile) => {
                        const box = tile.getBoundingClientRect();
                        const target = tile.querySelector('select') ?? tile;
                        const hits = [box.top + 4, box.top + box.height / 2, box.bottom - 4].every((y) => {
                            const hit = document.elementFromPoint(box.left + box.width / 2, y);
                            return !!hit && (hit === target || target.contains(hit) || tile.contains(hit));
                        });
                        return { name: tile.textContent?.trim().slice(0, 20), top: box.top, bottom: box.bottom, hits };
                    });
                    return {
                        formScroll: form.scrollHeight - form.clientHeight,
                        viewScroll: view.scrollHeight - view.clientHeight,
                        gridBottom: grid.bottom,
                        reserveTop,
                        ctaTop: cta.top,
                        ctaBottom: cta.bottom,
                        dateClip: date.scrollWidth - date.clientWidth,
                        selects,
                        corners,
                        tiles,
                    };
                });
                expect(m.formScroll, `the page's column scrolls by ${m.formScroll}px`).toBeLessThanOrEqual(1);
                expect(m.viewScroll, `the view scrolls by ${m.viewScroll}px`).toBeLessThanOrEqual(1);
                // The CTA keeps the iPhone's 8 pt above the tab bar or the pane's edge.
                expect(limit - m.ctaBottom).toBeGreaterThanOrEqual(6);
                expect(limit - m.ctaBottom).toBeLessThanOrEqual(10);
                // Fills: the tiles run down to the CTA's band, never into it.
                expect(m.gridBottom, 'the tiles end above the CTA band').toBeLessThanOrEqual(m.reserveTop + 0.5);
                expect(m.reserveTop - m.gridBottom, 'the tiles end within 16 px of the CTA band').toBeLessThanOrEqual(
                    16,
                );
                expect(m.tiles.length).toBe(state === 'empty' ? 3 : 4);
                for (const tile of m.tiles) {
                    expect(tile.bottom - tile.top, `${tile.name} is a 44 pt target`).toBeGreaterThanOrEqual(44 - 0.5);
                    expect(tile.bottom, `${tile.name} clears the CTA`).toBeLessThanOrEqual(m.ctaTop + 0.5);
                    expect(tile.hits, `${tile.name} is not covered`).toBe(true);
                }
                expect(m.dateClip, 'the date is not clipped').toBeLessThanOrEqual(0);
                expect(m.selects).toHaveLength(2);
                for (const select of m.selects) {
                    expect(select.height, 'the hour and minutes are 44 pt tall').toBeGreaterThanOrEqual(44 - 0.5);
                    // 44 pt wide, but on a 320 pt phone, where the date needs the room.
                    expect(select.width).toBeGreaterThanOrEqual(size.width < 360 ? 32 - 0.5 : 44 - 0.5);
                }
                expect(m.corners, 'a tap anywhere on the time pill opens a select').toEqual(Array(4).fill('SELECT'));
            });
        }
    }
});

test.describe('Plan front door on a tall iPad and in phone landscape', () => {
    for (const state of STATES) {
        test(`${state}: a 12.9-inch iPad in full screen centres the group between header and CTA`, async ({
            page,
            baseURL,
        }) => {
            await open(page, baseURL, 1024, 1366, state, false);
            const m = await page.evaluate(() => {
                const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
                const header = box('.route-planner-page [data-page-header]');
                const card = box('.plan-launch');
                const grid = box('.plan-doors');
                const tile = box('.plan-tile');
                const cta = box('.route-planner-cta > div');
                const form = document.querySelector<HTMLElement>('.route-planner-form')!;
                return {
                    above: card.top - header.bottom,
                    below: cta.top - grid.bottom,
                    tile: { width: tile.width, height: tile.height },
                    formScroll: form.scrollHeight - form.clientHeight,
                };
            });
            expect(m.formScroll).toBeLessThanOrEqual(1);
            // The tiles grow to about their width, no further…
            expect(m.tile.height).toBeGreaterThan(200);
            expect(m.tile.height).toBeLessThanOrEqual(m.tile.width * 1.1 + 6);
            // …and what they leave is shared above the card and below them
            // (the CTA band's 8 px reserve sits below the tiles).
            expect(Math.abs(m.above + 8 - m.below), `above ${m.above}, below ${m.below}`).toBeLessThanOrEqual(3);
        });

        for (const size of LANDSCAPE) {
            test(`${state} at ${size.name}: the card beside the tiles, all above the CTA`, async ({
                page,
                baseURL,
            }) => {
                await open(page, baseURL, size.width, size.height, state);
                const m = await page.evaluate(() => {
                    const view = document.querySelector('.route-planner-page')!.parentElement!;
                    const card = document.querySelector('.plan-launch')!.getBoundingClientRect();
                    const grid = document.querySelector('.plan-doors')!.getBoundingClientRect();
                    const cta = document.querySelector('.route-planner-cta > div')!.getBoundingClientRect();
                    const tiles = [...document.querySelectorAll<HTMLElement>('.plan-tile')].map((tile) => {
                        const box = tile.getBoundingClientRect();
                        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
                        return {
                            name: tile.textContent?.trim().slice(0, 20),
                            height: box.height,
                            bottom: box.bottom,
                            hits: !!hit && tile.contains(hit),
                        };
                    });
                    return {
                        viewScroll: view.scrollHeight - view.clientHeight,
                        card: { top: card.top, right: card.right, bottom: card.bottom },
                        grid: { top: grid.top, left: grid.left, bottom: grid.bottom },
                        cta: { top: cta.top, bottom: cta.bottom },
                        tiles,
                    };
                });
                // Two columns, top-aligned, as the Vessel page in landscape.
                expect(m.grid.left).toBeGreaterThan(m.card.right);
                expect(Math.abs(m.grid.top - m.card.top)).toBeLessThanOrEqual(1);
                // One screen, every state (the Plan Your Day trial notice that
                // used to scroll an SE by its third line went in build 124).
                expect(m.viewScroll, `the view scrolls by ${m.viewScroll}px`).toBeLessThanOrEqual(1);
                expect(m.cta.bottom).toBeLessThanOrEqual(size.height);
                expect(m.card.bottom).toBeLessThanOrEqual(m.cta.top);
                expect(m.grid.bottom).toBeLessThanOrEqual(m.cta.top);
                expect(m.tiles.length).toBe(state === 'empty' ? 3 : 4);
                for (const tile of m.tiles) {
                    expect(tile.height, `${tile.name} is a 44 pt target`).toBeGreaterThanOrEqual(44 - 0.5);
                    expect(tile.bottom, `${tile.name} clears the CTA`).toBeLessThanOrEqual(m.cta.top + 0.5);
                    expect(tile.hits, `${tile.name} is not covered`).toBe(true);
                }
            });
        }
    }
});

test.describe('Plan front door keeps every item', () => {
    for (const state of STATES) {
        test(`${state}: every inventory item is on the page`, async ({ page, baseURL }) => {
            await open(page, baseURL, 390, 844, state);
            const planner = page.locator('.route-planner-page');

            // Header: title, caption and the actions menu (no Back on the tab page).
            await expect(planner.getByRole('heading', { level: 1, name: 'Route Planner' })).toBeVisible();
            await expect(planner.getByText('Passages & day sails', { exact: true })).toBeVisible();
            const actions = planner.getByRole('button', { name: 'Route Planner actions', exact: true });
            await expect(actions).toHaveAttribute('aria-haspopup', 'dialog');
            await expect(actions).toHaveAttribute('aria-expanded', 'false');
            await expect(planner.getByRole('button', { name: /^(Go back|Back)/ })).toHaveCount(0);

            // Departure: the named group, date, 24-hour time, Now, and the chip.
            const departure = planner.getByRole('group', { name: 'Departure', exact: true });
            await expect(departure.getByLabel('Departure date', { exact: true })).toBeVisible();
            await expect(departure.getByLabel('Departure hour (24-hour)', { exact: true })).toBeVisible();
            await expect(departure.getByLabel('Departure minutes', { exact: true })).toBeVisible();
            const now = departure.getByRole('button', { name: 'Now', exact: true });
            await expect(now).toBeEnabled();
            await expect(now).toHaveAttribute('aria-pressed', state === 'empty' ? 'true' : 'false');
            await expect(departure.getByText('leaving now', { exact: true })).toHaveCount(state === 'empty' ? 1 : 0);
            if (state !== 'empty') {
                await expect(departure.getByLabel('Departure hour (24-hour)', { exact: true })).toHaveValue('06');
                await expect(departure.getByLabel('Departure minutes', { exact: true })).toHaveValue('30');
            }

            // The active vessel, and Personalise only on the default vessel.
            await expect(planner.getByText(/^Active vessel:/)).toBeVisible();
            await expect(planner.getByRole('button', { name: 'Personalise vessel profile in Settings' })).toHaveCount(
                state === 'full' ? 1 : 0,
            );

            // The ways in, named by title, described by their full sublines.
            const doors = planner.getByRole('group', { name: 'Or start from', exact: true });
            await expect(doors.getByRole('button', { name: 'Saved routes', exact: true })).toHaveAccessibleDescription(
                state === 'empty' ? 'None saved on this device yet' : '3 saved · timings refreshed for today’s tide',
            );
            await expect(doors.getByRole('button', { name: 'Past voyages', exact: true })).toHaveAccessibleDescription(
                'Turn a logged voyage into a route',
            );
            const day = doors.getByRole('button', { name: 'Plan Your Day', exact: true });
            await expect(day).toHaveAccessibleDescription('Go or stay, when, and where to.');
            await expect(day).toHaveAttribute('aria-haspopup', 'dialog');
            await expect(day).toHaveAttribute('aria-expanded', 'false');
            // A button since 126-16a: it opens the Trip sheet (no wheel, no dead first option).
            const trip = doors.getByRole('button', { name: 'Trip · Legs', exact: true });
            if (state === 'empty') {
                // Nothing saved: no empty furniture.
                await expect(trip).toHaveCount(0);
            } else {
                await expect(trip).toHaveAccessibleDescription('2 saved · pick one to continue');
                await expect(trip).toHaveAttribute('aria-haspopup', 'dialog');
                await expect(doors.getByText('Trip · Legs', { exact: true })).toBeVisible();
            }
            // Plan Your Day opens at once: no Auto route (trial) switch, no draft check (build 124).
            await day.click();
            const today = page.getByRole('dialog', { name: 'Plan Your Day', exact: true });
            await expect(today).toBeVisible();
            await today.getByRole('button', { name: 'Close', exact: true }).click();
            await expect(today).toHaveCount(0);
            await expect(day).toHaveAttribute('aria-expanded', 'false');

            // The CTA.
            await expect(page.getByRole('button', { name: 'Start plotting', exact: true })).toBeVisible();

            // The actions menu still holds Import GPX.
            await actions.click();
            const menu = page.getByRole('dialog', { name: 'Route Planner actions' });
            await expect(menu.getByRole('button', { name: 'Import GPX', exact: true })).toHaveAccessibleDescription(
                'OpenCPN · Navionics — bring routes aboard',
            );
            await menu.getByRole('button', { name: 'Close', exact: true }).click();
            await expect(menu).toHaveCount(0);

            if (state !== 'empty') {
                // The tile opens the Trip sheet: your trips, newest first, then a
                // trip's legs with the next leg to add and the way home
                // (2026-10-07): the return trip and a ⇄ per leg.
                await trip.click();
                const trips = page.getByRole('dialog', { name: 'Your trips' });
                await expect(trips.getByRole('list', { name: 'Trips' }).getByRole('button')).toHaveText([
                    /^Harbour - Sandy Cove.*2 legs/,
                    /^Marina - Island Anchorage.*1 leg\b/,
                ]);
                await trips.getByRole('button', { name: /^Harbour - Sandy Cove/ }).click();
                const legs = page.getByRole('dialog', { name: 'Harbour - Sandy Cove' });
                await expect(legs.getByText(/^2 legs · [\d.]+ NM$/)).toBeVisible();
                await expect(legs.getByRole('button', { name: /^Leg 1: Harbour - Bay Point/ })).toBeVisible();
                await expect(legs.getByRole('button', { name: /^Leg 2: Bay Point - Sandy Cove/ })).toBeVisible();
                await expect(legs.getByRole('button', { name: '+ Add the 3rd leg from Sandy Cove' })).toBeVisible();
                await expect(legs.getByRole('button', { name: /^⇄ Plan the return trip/ })).toBeVisible();
                await expect(
                    legs.getByRole('button', { name: 'Return from Sandy Cove: legs 2 to 1 reversed', exact: true }),
                ).toBeVisible();
                await expect(
                    legs.getByRole('button', { name: 'Return from Bay Point: leg 1 reversed', exact: true }),
                ).toBeVisible();
                await legs.getByRole('button', { name: 'Close', exact: true }).click();
                await expect(page.getByRole('dialog')).toHaveCount(0);
            }
        });
    }
});

test.describe('Trip · Legs keeps the way home within reach', () => {
    for (const size of [
        { name: '320x568', width: 320, height: 568 },
        { name: 'SE +insets', width: 375, height: 662 },
        { name: '390x844', width: 390, height: 844 },
        { name: '1024x768 split', width: 1024, height: 768 },
    ]) {
        test(`the legs, their ⇄ and the return trip fit at ${size.name}`, async ({ page, baseURL }) => {
            await open(page, baseURL, size.width, size.height, 'planning');
            await page.getByRole('button', { name: 'Trip · Legs', exact: true }).click();
            await page
                .getByRole('dialog', { name: 'Your trips' })
                .getByRole('button', { name: /^Harbour - Sandy Cove/ })
                .click();
            const dialog = page.getByRole('dialog', { name: /Harbour - Sandy Cove/ });
            await expect(dialog).toBeVisible();
            // The cyclone-season card (W1-12) loads below the legs: measure with it in place.
            const season = dialog.getByRole('list', { name: 'Tropical cyclones near this route by month' });
            await expect(season).toBeAttached({ timeout: 15_000 });
            await dialog.getByRole('button', { name: /^⇄ Plan the return trip/ }).scrollIntoViewIfNeeded();
            const m = await dialog.evaluate((box) => {
                const frame = box.getBoundingClientRect();
                const targets = [...box.querySelectorAll<HTMLElement>('button')].map((button) => {
                    const r = button.getBoundingClientRect();
                    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                    return {
                        name: button.getAttribute('aria-label') ?? button.textContent?.trim().slice(0, 30),
                        width: r.width,
                        height: r.height,
                        inside: r.left >= frame.left - 0.5 && r.right <= frame.right + 0.5,
                        hit: !!hit && (hit === button || button.contains(hit)),
                        // A leg name truncates rather than wrapping the row.
                        clipped: [...button.querySelectorAll<HTMLElement>('span')].some(
                            (span) => !span.classList.contains('truncate') && span.scrollWidth > span.clientWidth + 1,
                        ),
                    };
                });
                const scroller = box.querySelector<HTMLElement>('.overflow-y-auto')!;
                return {
                    overflowX: box.scrollWidth - box.clientWidth,
                    scrollerX: scroller.scrollWidth - scroller.clientWidth,
                    withinViewport: frame.top >= 0 && frame.bottom <= window.innerHeight,
                    targets,
                };
            });
            expect(m.overflowX, 'the dialog never scrolls sideways').toBeLessThanOrEqual(0);
            expect(m.scrollerX, 'the legs list never scrolls sideways').toBeLessThanOrEqual(0);
            expect(m.withinViewport, 'the dialog sits inside the screen').toBe(true);
            const chips = m.targets.filter((t) => t.name?.startsWith('Return from'));
            expect(chips).toHaveLength(2);
            for (const target of m.targets) {
                expect(target.height, `${target.name} is a 44 pt target`).toBeGreaterThanOrEqual(44 - 0.5);
                expect(target.inside, `${target.name} stays inside the dialog`).toBe(true);
                expect(target.clipped, `${target.name} is not clipped`).toBe(false);
            }
            for (const chip of chips) {
                expect(chip.width, `${chip.name} is 44 pt wide`).toBeGreaterThanOrEqual(44 - 0.5);
                expect(chip.hit, `${chip.name} is not covered`).toBe(true);
            }
            const returnRow = m.targets.find((t) => t.name?.startsWith('⇄ Plan the return trip'));
            expect(returnRow?.hit, 'the return-trip row is not covered').toBe(true);

            // Scrolled to, the season strip sits inside the dialog with every month's count in its cell.
            await season.scrollIntoViewIfNeeded();
            await expect(season).toBeVisible();
            const strip = await season.evaluate((list) => {
                const frame = list.closest('[role="dialog"]')!.getBoundingClientRect();
                const r = list.getBoundingClientRect();
                const cells = [...list.querySelectorAll<HTMLElement>('li')];
                return {
                    cells: cells.length,
                    inside: r.left >= frame.left - 0.5 && r.right <= frame.right + 0.5,
                    clipped: cells.some((li) => li.scrollWidth > li.clientWidth + 1),
                };
            });
            expect(strip.cells, 'twelve months').toBe(12);
            expect(strip.inside, 'the season strip stays inside the dialog').toBe(true);
            expect(strip.clipped, 'no month cell is clipped').toBe(false);
        });
    }
});

// ── The Trip sheet (126-16a): your trips, a trip's legs, the next leg to add.
//    One centred card in Plan Your Day's band, clear of the tab bar; the header
//    and footer stay put and only the middle scrolls. A fictional worldwide
//    library: a four-leg Bay of Islands trip, Newport → Gladstone → Mackay →
//    Airlie Beach, the Solent, the Caribbean, the Atlantic, the Arctic, the
//    Ogasawara islands and Fiji across the antimeridian. ──

type Pt = { lat: number; lon: number };
const SHEET_NM = 1 / 60.04; // degrees of latitude per NM

function sheetLibrary(): unknown[] {
    const at = (day: number) => new Date(Date.UTC(2026, 8, day, 8)).toISOString();
    const line = (a: Pt, b: Pt): Pt[] => [a, { lat: (a.lat + b.lat) / 2 + 0.004, lon: (a.lon + b.lon) / 2 }, b];
    const badge = ['', '', ' (2nd Leg)', ' (3rd Leg)', ' (4th Leg)'];
    const route = (id: string, name: string, points: Pt[], day: number, extra: Record<string, unknown> = {}) => ({
        id,
        name,
        createdAt: at(day),
        points,
        ...extra,
    });
    const trip = (id: string, legs: Array<[string, Pt[]]>, day: number, extra: Record<number, object> = {}) =>
        legs.map(([name, points], i) =>
            route(i ? `${id}-${i + 1}` : id, `${name}${i ? badge[i + 1] : ' (1st Leg)'}`, points, day + i, {
                tripId: id,
                legOrdinal: i + 1,
                ...(extra[i + 1] ?? {}),
            }),
        );
    const OPUA = { lat: -35.31, lon: 174.12 };
    const RUSSELL = { lat: -35.26, lon: 174.12 };
    const ROBERTON = { lat: -35.22, lon: 174.16 };
    const URUPUKAPUKA = { lat: -35.22, lon: 174.23 };
    const WHANGAROA = { lat: -35.04, lon: 173.75 };
    const MANGONUI = { lat: -34.99, lon: 173.53 };
    const DOUBTLESS = { lat: -34.93, lon: 173.47 };
    const NEWPORT = { lat: -27.21, lon: 153.09 };
    const GLADSTONE = { lat: -23.84, lon: 151.26 };
    const MACKAY = { lat: -21.1, lon: 149.23 };
    const AIRLIE = { lat: -20.27, lon: 148.72 };
    return [
        ...trip(
            'boi',
            [
                ['Opua - Russell', line(OPUA, RUSSELL)],
                ['Russell - Roberton Island', line(RUSSELL, ROBERTON)],
                // Starts 0.9 NM off the chain: an amber joint.
                [
                    'Roberton Island - Urupukapuka',
                    line({ lat: ROBERTON.lat + 0.9 * SHEET_NM, lon: ROBERTON.lon }, URUPUKAPUKA),
                ],
                ['Urupukapuka - Whangaroa', line(URUPUKAPUKA, WHANGAROA)],
            ],
            24,
            { 1: { plannedRouteId: 'planned_boi_1' } },
        ),
        ...trip(
            'npt',
            [
                ['Newport - Gladstone', line(NEWPORT, GLADSTONE)],
                ['Gladstone - Mackay', line(GLADSTONE, MACKAY)],
                ['Mackay - Airlie Beach', line(MACKAY, AIRLIE)],
            ],
            15,
        ),
        // The next leg from Whangaroa: one starts there, one ends 0.6 NM off.
        route('whangaroa', 'Whangaroa - Mangonui', line(WHANGAROA, MANGONUI), 12),
        ...trip(
            'dbl',
            [
                ['Doubtless Bay - Mangonui', line(DOUBTLESS, MANGONUI)],
                ['Mangonui - Whangaroa', line(MANGONUI, { lat: WHANGAROA.lat + 0.6 * SHEET_NM, lon: WHANGAROA.lon })],
            ],
            10,
        ),
        route('lymington', 'Lymington - Yarmouth', line({ lat: 50.755, lon: -1.53 }, { lat: 50.707, lon: -1.5 }), 9),
        route('cowes', 'Cowes - Hamble', line({ lat: 50.765, lon: -1.297 }, { lat: 50.857, lon: -1.31 }), 8),
        route(
            'antigua',
            'English Harbour - Jolly Harbour',
            line({ lat: 17.0, lon: -61.76 }, { lat: 17.07, lon: -61.89 }),
            7,
        ),
        route('stlucia', 'Rodney Bay - Marigot Bay', line({ lat: 14.08, lon: -60.95 }, { lat: 13.97, lon: -61.03 }), 6),
        route('cadiz', 'Cádiz → Funchal', line({ lat: 36.53, lon: -6.3 }, { lat: 32.64, lon: -16.91 }), 5),
        route('arctic', 'Tromsø - Skjervøy', line({ lat: 69.65, lon: 18.96 }, { lat: 70.03, lon: 20.97 }), 4),
        route('bonin', '父島 - 母島', line({ lat: 27.09, lon: 142.19 }, { lat: 26.64, lon: 142.16 }), 3),
        route('atlantic', "St. John's (NL) - Horta", line({ lat: 47.56, lon: -52.71 }, { lat: 38.53, lon: -28.63 }), 2),
        route(
            'fiji',
            'Savusavu - Taveuni',
            [
                { lat: -16.8, lon: 179.95 },
                { lat: -16.8, lon: -179.99 },
                { lat: -16.75, lon: -179.9 },
            ],
            1,
        ),
    ];
}

/** Every house rule for the open sheet, measured in the page; what broke. */
function sheetIssues(page: Page, limit: number) {
    return page.evaluate((floorY) => {
        const issues: string[] = [];
        const card = document.querySelector<HTMLElement>('[role="dialog"][data-trip-sheet]');
        if (!card) return ['no sheet'];
        const overlay = card.parentElement!;
        const o = overlay.getBoundingClientRect();
        const style = getComputedStyle(overlay);
        const bandTop = o.top + parseFloat(style.paddingTop);
        const bandBottom = o.bottom - parseFloat(style.paddingBottom);
        const box = card.getBoundingClientRect();
        const header = card.querySelector('header')!;
        const footer = card.querySelector('footer');
        const scroller = card.querySelector<HTMLElement>(':scope > .overflow-y-auto')!;
        if (Math.abs(box.left - o.left - (o.right - box.right)) > 1.5) issues.push('not centred across');
        if (Math.abs((box.top + box.bottom) / 2 - (bandTop + bandBottom) / 2) > 1.5)
            issues.push('not centred in its band');
        if (box.top < bandTop - 0.5) issues.push(`top ${box.top} above the band ${bandTop}`);
        if (box.bottom > floorY - 8 + 0.5) issues.push(`bottom ${box.bottom} within 8 px of the tab bar (${floorY})`);
        // Only the middle scrolls.
        if (card.scrollHeight > card.clientHeight + 1) issues.push('the card scrolls');
        if (header.scrollHeight > header.clientHeight + 1) issues.push('the header scrolls');
        if (footer && footer.scrollHeight > footer.clientHeight + 1) issues.push('the footer scrolls');
        if (getComputedStyle(scroller).overflowY !== 'auto') issues.push('the middle cannot scroll');
        // Nothing sideways.
        if (card.scrollWidth > card.clientWidth + 1) issues.push('the card scrolls sideways');
        if (scroller.scrollWidth > scroller.clientWidth + 1) issues.push('the list scrolls sideways');
        if (document.documentElement.scrollWidth > window.innerWidth + 1) issues.push('the page scrolls sideways');
        const list = scroller.getBoundingClientRect();
        for (const button of card.querySelectorAll<HTMLElement>('button')) {
            const r = button.getBoundingClientRect();
            const name = button.getAttribute('aria-label') ?? button.textContent?.trim().slice(0, 32);
            // A row scrolled out of the middle is measured once it is scrolled in.
            if (scroller.contains(button) && (r.top < list.top - 0.5 || r.bottom > list.bottom + 0.5)) continue;
            if (r.height < 43.5) issues.push(`${name}: ${r.height}px tall`);
            if (r.left < box.left - 0.5 || r.right > box.right + 0.5) issues.push(`${name} escapes the card`);
            if (button.scrollWidth > button.clientWidth + 1) issues.push(`${name}: its words overflow`);
            if (
                [...button.querySelectorAll<HTMLElement>('span')].some(
                    (span) =>
                        !span.classList.contains('truncate') &&
                        !span.classList.contains('sr-only') &&
                        span.scrollWidth > span.clientWidth + 1,
                )
            ) {
                issues.push(`${name}: a line is clipped`);
            }
            const inset = Math.min(4, r.height / 3);
            for (const [x, y] of [
                [(r.left + r.right) / 2, (r.top + r.bottom) / 2],
                [(r.left + r.right) / 2, r.top + inset],
                [(r.left + r.right) / 2, r.bottom - inset],
            ]) {
                const hit = document.elementFromPoint(x, y);
                if (!(hit === button || button.contains(hit))) issues.push(`${name} is covered by ${hit?.tagName}`);
            }
        }
        return issues;
    }, limit);
}

const SHEET_SIZES = [
    { name: '320x568', width: 320, height: 568 },
    { name: 'SE +insets', width: 375, height: 662 },
    // The 47 pt status bar and 34 pt home bar off the viewport, as drawn
    // (day-planner-layout.spec.ts's AS_DRAWN convention).
    { name: '390x844 +insets', width: 390, height: 779 },
    { name: '430x932 +insets', width: 430, height: 856 },
    { name: '1024x768 split', width: 1024, height: 768 },
];

test.describe('Trip sheet fits one screen', () => {
    for (const size of SHEET_SIZES) {
        test(`your trips, a four-leg trip and the next leg at ${size.name}`, async ({ page, baseURL }, info) => {
            await open(page, baseURL, size.width, size.height, 'planning', size.width >= 1024, {
                traces: sheetLibrary(),
            });
            const limit = await floor(page);
            // trip-sheet-430-trip.png, trip-sheet-430-add.png, trip-sheet-320-trip.png… to LOOK at.
            const shot = (name: string) =>
                page.screenshot({ path: info.outputPath(`${name}.png`), animations: 'disabled' });

            // (a) Your trips: thirteen, newest first.
            await page.getByRole('button', { name: 'Trip · Legs', exact: true }).click();
            const sheet = page.locator('[role="dialog"][data-trip-sheet]');
            await expect(sheet.getByRole('heading', { name: 'Your trips' })).toBeVisible();
            await expect(sheet.getByRole('list', { name: 'Trips' }).getByRole('button')).toHaveCount(13);
            await expect(sheet.getByRole('list', { name: 'Trips' }).getByRole('button').first()).toHaveText(
                /^Opua - Whangaroa.*4 legs/,
            );
            await settle(page);
            expect(await sheetIssues(page, limit)).toEqual([]);
            await shot(`trip-sheet-${size.width}-trips`);

            // (b) The four-leg trip.
            await sheet.getByRole('button', { name: /^Opua - Whangaroa/ }).click();
            await expect(sheet.getByRole('heading', { name: 'Opua - Whangaroa' })).toBeVisible();
            await expect(sheet.getByText("starts 0.9 NM from leg 2's end")).toBeVisible();
            await expect(sheet.getByText('⛓ joined')).toHaveCount(2);
            const cta = sheet.getByRole('button', { name: '+ Add the 5th leg from Whangaroa' });
            await expect(cta).toBeVisible();
            await settle(page);
            expect(await sheetIssues(page, limit)).toEqual([]);
            const fit = await sheet.evaluate((card) => {
                const scroller = card.querySelector<HTMLElement>(':scope > .overflow-y-auto')!;
                const list = scroller.getBoundingClientRect();
                const cards = [...card.querySelectorAll<HTMLElement>('[aria-label^="Leg "]')];
                const footer = card.querySelector('footer')!.getBoundingClientRect();
                const label = card.querySelector('footer button span')!;
                const line = parseFloat(getComputedStyle(label).lineHeight) || 18;
                return {
                    scrollTop: scroller.scrollTop,
                    cardsInView: cards.filter((c) => c.getBoundingClientRect().bottom <= list.bottom + 0.5).length,
                    footerInView:
                        footer.top >= list.bottom - 0.5 && footer.bottom <= card.getBoundingClientRect().bottom + 0.5,
                    ctaOneLine:
                        label.scrollWidth <= label.clientWidth + 1 &&
                        label.getBoundingClientRect().height <= line * 1.5,
                };
            });
            expect(fit.scrollTop).toBe(0);
            expect(fit.footerInView, 'the footer is in view').toBe(true);
            // Four cards and the footer with no scroll, even on the smallest phone.
            expect(fit.cardsInView, 'leg cards in view before any scroll').toBe(4);
            if (size.width >= 430) expect(fit.ctaOneLine, 'the footer CTA is on one line').toBe(true);
            await shot(`trip-sheet-${size.width}-trip`);

            // (c) The 5th leg from Whangaroa: all three sections.
            await cta.click();
            await expect(sheet.getByRole('heading', { name: '5th leg from Whangaroa' })).toBeVisible();
            await expect(
                sheet
                    .getByRole('list', { name: 'Starts at Whangaroa' })
                    .getByRole('button', { name: /^Whangaroa - Mangonui/ }),
            ).toBeVisible();
            await expect(
                sheet
                    .getByRole('list', { name: 'Ends at Whangaroa — sail it the other way' })
                    .getByRole('button', { name: /^Mangonui - Whangaroa.*0\.6 NM joining run/ }),
            ).toBeVisible();
            await settle(page);
            expect(await sheetIssues(page, limit)).toEqual([]);
            await shot(`trip-sheet-${size.width}-add`);
            await sheet.getByRole('button', { name: /^Show \d+ more$/ }).click();
            const further = sheet.getByRole('list', { name: 'Further away' });
            await expect(further.getByRole('button').first()).toBeDisabled();
            await further.getByRole('button').last().scrollIntoViewIfNeeded();
            expect(await sheetIssues(page, limit)).toEqual([]);
        });
    }

    for (const size of [SHEET_SIZES[0], SHEET_SIZES[2]]) {
        test(`the search fields stay above the keyboard at ${size.name}`, async ({ page, baseURL }) => {
            await open(page, baseURL, size.width, size.height, 'planning', false, {
                traces: sheetLibrary(),
                keyboard: true,
            });
            const keyboard = Math.round(size.height * 0.42);
            const aboveKeyboard = async (name: string) => {
                const field = page.getByRole('searchbox', { name });
                await field.focus();
                await page.evaluate(
                    (h) => window.dispatchEvent(new CustomEvent('test:keyboard', { detail: h })),
                    keyboard,
                );
                await expect(page.locator('html')).toHaveAttribute('data-keyboard-open', 'true');
                await expect
                    .poll(() =>
                        field.evaluate((element, h) => {
                            const r = element.getBoundingClientRect();
                            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                            return (
                                r.top >= 0 &&
                                r.bottom <= window.innerHeight - h &&
                                (hit === element || element.contains(hit))
                            );
                        }, keyboard),
                    )
                    .toBe(true);
                await page.evaluate(() => window.dispatchEvent(new CustomEvent('test:keyboard', { detail: 0 })));
                await expect(page.locator('html')).toHaveAttribute('data-keyboard-open', 'false');
            };
            await page.getByRole('button', { name: 'Trip · Legs', exact: true }).click();
            await aboveKeyboard('Search your trips');
            const sheet = page.locator('[role="dialog"][data-trip-sheet]');
            await sheet.getByRole('button', { name: /^Opua - Whangaroa/ }).click();
            await sheet.getByRole('button', { name: '+ Add the 5th leg from Whangaroa' }).click();
            await aboveKeyboard('Search routes and legs');
        });
    }
});
