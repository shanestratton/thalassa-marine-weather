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
 *
 * Crew & Float Plan is a card of its own above the box since 128-HUES (Shane
 * 2026-10-13: "ok the crew and float plan, really needs its own card, can we
 * make a nice card for it without having to scroll up and down on the page,
 * maybe a nice hue as well on the back of it"): the page still fits.
 */
import { expect, test, type Page } from '@playwright/test';
import { ONBOARDED_STORAGE } from '../e2e/helpers/storageState';
import { SETTINGS_STATE_WORDS } from '../components/settings/menuStatusWords';
import { expectPalette } from './helpers/palette';
import { crewCountWords, crewInvitedWords } from '../components/vesselHub/crewCardWords';

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
    /** The home port Settings' Preferences row names. */
    home?: string;
    /** A fresh install: no vessel name, so the skipper card asks to set one up. */
    fresh?: boolean;
    /** Large text: the 24 px root the other layout specs use (129-14). */
    largeText?: boolean;
    /** Three people on the vessel profile, so the crew card shows a count (129-14). */
    roster?: boolean;
}

async function open(
    page: Page,
    baseURL: string | undefined,
    {
        width,
        height,
        view,
        split = false,
        mode = 'dark',
        trip = false,
        home,
        fresh = false,
        largeText = false,
        roster = false,
    }: Open,
) {
    await page.setViewportSize({ width, height });
    const origin = new URL(baseURL!).origin;
    await page.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.addInitScript(
        ({ split, mode, trip, home, fresh, largeText, roster }) => {
            localStorage.setItem('thalassa_split_view', split ? '1' : '0');
            for (const key of [
                'thalassa_settings_mirror::anonymous',
                'CapacitorStorage.thalassa_settings::anonymous',
            ]) {
                const saved = JSON.parse(localStorage.getItem(key)!);
                saved.settings.displayMode = mode;
                if (home) saved.settings.defaultLocation = home;
                if (fresh) saved.settings.vessel = { ...saved.settings.vessel, name: '' };
                // Fictional people (the repository is public).
                if (roster)
                    saved.settings.vessel = {
                        ...saved.settings.vessel,
                        crewCount: 3,
                        crewRoster: [
                            { name: 'Ingrid Solberg', rank: 'Skipper', dateOfBirth: '1979-10-15' },
                            { name: 'Kenji Watanabe', rank: 'First mate', age: 52 },
                            { name: 'Amara Okafor', rank: 'Crew' },
                        ],
                    };
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
                wide.textContent =
                    ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; }" +
                    (largeText ? ' html { font-size: 24px !important; }' : '');
                document.head.append(wide);
            });
        },
        { split, mode, trip, home, fresh, largeText, roster },
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

/** The menu box's rows, and with the crew card's every row of the menu. */
const BOX_ROWS =
    '[data-testid="vessel-hub-menu"] > button, [data-testid="vessel-hub-menu"] > .vessel-hub-tools > button';
const MENU_ROWS = `[data-testid="vessel-hub-crew"] > button, ${BOX_ROWS}`;
const ORDER = ['Crew & Float Plan', 'Boat Binder', 'NMEA Gateway', 'Systems', 'Music', 'Settings', 'Boat Network'];

/** Crew & Float Plan's own card (128-HUES): one, its one row, just above the
 *  box and as wide, a gap between them, its row the height of the box's, and
 *  its hue drawn: an edge that is not the box's, a wash and a halo. */
async function crewCard(page: Page) {
    await expect(page.getByTestId('vessel-hub-crew')).toHaveCount(1);
    const m = await page.evaluate(() => {
        const crew = document.querySelector<HTMLElement>('[data-testid="vessel-hub-crew"]')!;
        const box = document.querySelector<HTMLElement>('[data-testid="vessel-hub-menu"]')!;
        const a = crew.getBoundingClientRect();
        const b = box.getBoundingClientRect();
        const style = getComputedStyle(crew);
        const height = (name: string) =>
            document.querySelector(`[aria-label="${name}"]`)!.getBoundingClientRect().height;
        // A computed colour's alpha, 0-255: rgba(), or a mix's oklab() / color() with "/ a".
        const alpha = (colour: string) => {
            const slash = colour.match(/\/\s*([\d.]+)\s*\)$/);
            const rgba = colour.match(/^rgba\([^)]*,\s*([\d.]+)\s*\)$/);
            return Math.round(255 * Number(slash?.[1] ?? rgba?.[1] ?? 1));
        };
        const journal = document.querySelector('.vessel-hub-journal')!.getBoundingClientRect();
        const skipper = document.querySelector('[data-testid="skipper-device-card"]')!.getBoundingClientRect();
        return {
            rows: [...crew.querySelectorAll('button')].map((button) => button.getAttribute('aria-label')),
            gap: b.top - a.bottom,
            // The page's own card gap, the Diary pair's to the skipper card;
            // and the crew card's to the skipper card above it (in phone
            // landscape the menu is a column of its own, with nothing above).
            standardGap: skipper.top - journal.bottom,
            gapAbove: a.top >= skipper.bottom - 0.5 ? a.top - skipper.bottom : null,
            left: a.left - b.left,
            width: a.width - b.width,
            crewRow: height('Crew & Float Plan'),
            binderRow: height('Boat Binder'),
            edge: style.borderTopColor,
            boxEdge: getComputedStyle(box).borderTopColor,
            edgeAlpha: alpha(style.borderTopColor),
            wash: style.backgroundImage,
            halo: style.boxShadow,
        };
    });
    expect(m.rows).toEqual(['Crew & Float Plan']);
    expect(m.gap, 'a gap between the crew card and the box').toBeGreaterThanOrEqual(1.5);
    // Shane 2026-10-14 (129-14): "the new crew and float plan card does not
    // have the standard spacing between it and the primary device card above
    // it or the menu card below it". The page's one gap, above and below.
    expect(Math.abs(m.gap - m.standardGap), `below ${m.gap} vs the page's ${m.standardGap}`).toBeLessThanOrEqual(1);
    if (m.gapAbove !== null)
        expect(
            Math.abs(m.gapAbove - m.standardGap),
            `above ${m.gapAbove} vs the page's ${m.standardGap}`,
        ).toBeLessThanOrEqual(1);
    expect(Math.abs(m.left), 'the crew card lines up with the box').toBeLessThanOrEqual(0.5);
    expect(Math.abs(m.width), 'the crew card is as wide as the box').toBeLessThanOrEqual(0.5);
    expect(Math.abs(m.crewRow - m.binderRow), `crew row ${m.crewRow} vs ${m.binderRow}`).toBeLessThanOrEqual(1.5);
    expect(m.edge, 'its own edge, not the box').not.toBe(m.boxEdge);
    expect(m.edgeAlpha, 'its edge is drawn').toBeGreaterThan(40);
    expect(m.wash, 'a hue on its back').toContain('gradient');
    expect(m.halo, 'a halo around it').not.toBe('none');
    return m;
}

/** The 6.1-inch iPhones' Diary pair stacks with room to spare: the crew
 *  card's room comes out of the gaps, never the pair (128-HUES review), so a
 *  real phone a pixel shorter than these models still stacks it. */
const STACKED_PAIR = ['390x844', '6.1in Pro +insets'];
async function stackedPair(page: Page) {
    const pair = await page.locator('.vessel-hub-home .vessel-hub-journal').evaluate((journal) => ({
        height: journal.getBoundingClientRect().height,
        tiles: [...journal.querySelectorAll('.vessel-hub-tile')].map((tile) => getComputedStyle(tile).flexDirection),
    }));
    expect(pair.tiles, 'the Diary and Scuttlebutt cards stack').toEqual(['column', 'column']);
    expect(pair.height, 'the pair clears the 86 px it stacks at by 1.5 px').toBeGreaterThanOrEqual(87.5);
}

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
    for (const width of [300, 375]) {
        test(`Systems and Music remain reachable at ${width}px with 130% text`, async ({ page, baseURL }, info) => {
            await open(page, baseURL, { width, height: 667, view: 'vessel' });
            await expect(page.getByRole('button', { name: 'Systems', exact: true })).toBeVisible({ timeout: 25000 });
            await page.addStyleTag({ content: 'html{font-size:130% !important}' });
            await settle(page);
            const systems = page.getByRole('button', { name: 'Systems', exact: true }),
                music = page.getByRole('button', { name: 'Music', exact: true });
            // Larger text may need the page's existing native scroller. Use
            // its lower resting point, as in the short-screen check below;
            // WebKit's touch-device driver does not support mouse wheels.
            await page.locator('.vessel-hub-port').evaluate((port) => port.scrollTo({ top: port.scrollHeight }));
            await settle(page);
            await wholeRows(page, '.vessel-hub-tools > button', await floor(page));
            const measure = await page.locator('.vessel-hub-tools').evaluate((tools) => {
                const rows = [...tools.querySelectorAll<HTMLElement>(':scope > button')];
                const boxes = rows.map((row) => row.getBoundingClientRect());
                return {
                    horizontal: Math.abs(boxes[0].top - boxes[1].top) < 1 && boxes[0].right <= boxes[1].left + 1,
                    whole: rows.map((row) => {
                        const label = row.querySelector<HTMLElement>('.hub-row-label')!;
                        return label.scrollWidth <= label.clientWidth + 1;
                    }),
                    overflow: document.documentElement.scrollWidth - window.innerWidth,
                };
            });
            expect(measure.horizontal).toBe(true);
            expect(measure.whole).toEqual([true, true]);
            expect(measure.overflow).toBeLessThanOrEqual(1);
            await expect(systems).toHaveAccessibleDescription('Tanks, batteries & power');
            await expect(music).toHaveAccessibleDescription('Apple Music & speakers');
            await page.screenshot({ path: info.outputPath('vessel-systems-music.png') });
            await systems.click();
            await expect(page.getByRole('dialog', { name: 'Boat systems' })).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(page.getByRole('dialog', { name: 'Boat systems' })).toHaveCount(0);
            await expect(systems).toBeFocused();
            await music.click();
            await expect(page.getByRole('heading', { name: 'Apple Music', exact: true })).toBeVisible();
        });
    }
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
            expect(await page.locator(BOX_ROWS).count(), 'the box keeps the other six').toBe(6);
            await noScroll(page, '.vessel-hub-port');
            const limit = await floor(page);
            await wholeRows(page, MENU_ROWS, limit);
            await crewCard(page);
            if (STACKED_PAIR.includes(size.name)) await stackedPair(page);
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
            await crewCard(page);
        });
    }

    for (const mode of ['light', 'night'] as const) {
        test(`fits in ${mode} at 6.1in Pro +insets`, async ({ page, baseURL }) => {
            await open(page, baseURL, { width: 393, height: 775, view: 'vessel', mode });
            await expect(page.getByRole('button', { name: 'Open Diary', exact: true })).toBeVisible({
                timeout: 25_000,
            });
            await expectPalette(page, mode);
            await settle(page);
            await noScroll(page, '.vessel-hub-port');
            const limit = await floor(page);
            await wholeRows(page, MENU_ROWS, limit);
            await filled(page, limit);
            await crewCard(page);
            await stackedPair(page);
        });

        // The tightest phone that fits, in this palette too.
        test(`fits in ${mode} at SE +insets`, async ({ page, baseURL }) => {
            await open(page, baseURL, { width: 375, height: 662, view: 'vessel', mode });
            await expect(page.getByRole('button', { name: 'Open Diary', exact: true })).toBeVisible({
                timeout: 25_000,
            });
            await expectPalette(page, mode);
            await settle(page);
            await noScroll(page, '.vessel-hub-port');
            await wholeRows(page, MENU_ROWS, await floor(page));
            await crewCard(page);
        });
    }

    // Shane 2026-10-14 (129-14): the crew card sits the page's own gap from the
    // skipper card above it and the box below it, as the Diary pair sits from
    // the skipper card, at every size: a short phone and large text (where
    // the page is known to scroll), a tall phone, the iPad's pane and its
    // whole screen.
    const CARD_GAP_SIZES = [
        { name: '320x568', width: 320, height: 568 },
        { name: '390x844', width: 390, height: 844 },
        { name: 'Pro Max +insets', width: 430, height: 856 },
        { name: '1080x810 split +insets', width: 1080, height: 782, split: true },
        { name: '1366x1024 iPad', width: 1366, height: 1024 },
        { name: 'large text 390x844', width: 390, height: 844, largeText: true },
        { name: 'large text 320x568', width: 320, height: 568, largeText: true },
    ];
    for (const size of CARD_GAP_SIZES) {
        test(`spaces the crew card like every other card at ${size.name}`, async ({ page, baseURL }) => {
            // With a count on the card, as a skipper sees it. In large text a
            // row with a value is taller than one without (its rem-sized value
            // outgrows the 13 px title), so there the card shows none and its
            // row still matches the box's, as crewCard() checks.
            await open(page, baseURL, { ...size, view: 'vessel', roster: !size.largeText });
            await expect(page.getByRole('button', { name: 'Open Diary', exact: true })).toBeVisible({
                timeout: 25_000,
            });
            await settle(page);
            const m = await crewCard(page);
            expect(m.gapAbove, 'the skipper card is above the crew card').not.toBeNull();
            expect(m.standardGap, 'a gap, not cards touching').toBeGreaterThanOrEqual(1.5);
        });
    }

    // The card's words at their longest (129-14): the count and how many are
    // still invited, in the app's own words (components/vesselHub/
    // crewCardWords.ts), set on the real row and measured, at 320 pt in large
    // text and in the system size. Signed out, the row shows the profile's
    // count only; the words a signed-in skipper sees are set in place, a
    // layout probe as the Settings state words are below.
    for (const size of [
        { name: '320x568', width: 320, height: 568 },
        { name: 'large text 320x568', width: 320, height: 568, largeText: true },
        { name: 'large text 390x844', width: 390, height: 844, largeText: true },
    ]) {
        test(`the crew card's count and invite words fit at ${size.name}`, async ({ page, baseURL }) => {
            await open(page, baseURL, { ...size, view: 'vessel', roster: true });
            const row = page.getByRole('button', { name: 'Crew & Float Plan', exact: true });
            await expect(row).toContainText(crewCountWords(3), { timeout: 25_000 });
            await settle(page);
            const before = await row.evaluate((element) => element.getBoundingClientRect().height);
            const probe = await row.evaluate(
                (element, words) => {
                    const value = [...element.querySelectorAll<HTMLElement>('span[id$="-value"]')][0];
                    const status = element.querySelector<HTMLElement>('.hub-row-status')!;
                    value.textContent = words.value;
                    status.textContent = words.status;
                    const box = element.getBoundingClientRect();
                    const v = value.getBoundingClientRect();
                    const s = status.getBoundingClientRect();
                    const lineHeight = parseFloat(getComputedStyle(status).lineHeight);
                    return {
                        height: box.height,
                        valueWhole: value.scrollWidth <= value.clientWidth + 1 && v.right <= box.right + 0.5,
                        // The subtitle is one nowrap line with an ellipsis in the
                        // compact tiers: its own box always fits, so whole words
                        // are measured by what it holds against what it shows.
                        statusWhole: status.scrollWidth <= status.clientWidth + 1,
                        statusShown: `${status.scrollWidth} px in ${status.clientWidth}`,
                        statusInside: s.left >= box.left - 0.5 && s.right <= box.right + 0.5,
                        statusLines: Math.round(s.height / lineHeight),
                        overflow: element.scrollWidth - element.clientWidth,
                        pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                    };
                },
                { value: crewCountWords(99), status: crewInvitedWords(99) },
            );
            expect(probe.valueWhole, `"${crewCountWords(99)}" is whole`).toBe(true);
            expect(probe.statusWhole, `"${crewInvitedWords(99)}" is whole: ${probe.statusShown}`).toBe(true);
            expect(probe.statusInside, `"${crewInvitedWords(99)}" stays inside the row`).toBe(true);
            expect(probe.statusLines, 'one line, as every menu row on a short page').toBe(1);
            expect(Math.abs(probe.height - before), 'the row keeps its height').toBeLessThanOrEqual(0.5);
            expect(probe.overflow, 'nothing spills sideways out of the row').toBeLessThanOrEqual(1);
            expect(probe.pageOverflowX, 'no sideways page scroll').toBeLessThanOrEqual(0);
        });
    }

    // The vessel profile's crew rows ask a date of birth, not an age (129-14):
    // the platform's own date picker, whole inside its row, its age line under
    // it, on a 320 pt phone, a 390 pt one and in large text. A row with an age
    // typed before 129 says so. Kenji has only an age; Ingrid a date of birth.
    for (const size of [
        { name: '320x568', width: 320, height: 568 },
        { name: '390x844', width: 390, height: 844 },
        { name: 'large text 320x568', width: 320, height: 568, largeText: true },
    ]) {
        test(`the vessel profile's date of birth fields fit at ${size.name}`, async ({ page, baseURL }) => {
            await open(page, baseURL, { ...size, view: 'vessel', roster: true });
            await page.getByRole('button', { name: 'Settings', exact: true }).click({ timeout: 25_000 });
            await page.getByRole('button', { name: /^Open Vessel Profile settings/ }).click();
            const roster = page.getByTestId('vessel-crew-roster');
            await expect(roster).toBeVisible();
            await expect(page.getByLabel('Skipper date of birth', { exact: true })).toHaveValue('1979-10-15');
            await expect(roster).toContainText(/Age \d+ today/);
            await expect(roster).toContainText('Age 52 from before. Add date of birth so this stays right.');
            const issues = await roster.evaluate((element) => {
                const found: string[] = [];
                if (document.documentElement.scrollWidth > window.innerWidth + 1) found.push('page overflows sideways');
                for (const person of element.querySelectorAll<HTMLElement>('[data-testid^="vessel-crew-person-"]')) {
                    const block = person.getBoundingClientRect();
                    for (const field of person.querySelectorAll<HTMLElement>('input, select, p')) {
                        const box = field.getBoundingClientRect();
                        const name = field.getAttribute('aria-label') ?? field.textContent?.slice(0, 24);
                        if (box.left < block.left - 0.5 || box.right > block.right + 0.5)
                            found.push(`${name} runs out of its row`);
                        if (field.matches('input, select') && box.height < 43.5)
                            found.push(`${name} is ${box.height}px`);
                        if (field.matches('p') && field.scrollWidth > field.clientWidth + 1)
                            found.push(`${name} is cut`);
                    }
                }
                return found;
            });
            expect(issues).toEqual([]);
        });
    }

    // Typed on a keyboard, the web build's way (129-14 review): Chromium's date
    // field reports each digit of the year as it lands (0001-…, 0019-…, then
    // 1979-…) and an empty value while a part is being retyped. A field that
    // threw those away emptied itself on the first digit, and retyping the day
    // wiped the saved date. Each part goes in digit by digit, in the order this
    // Chromium asks for them: its own locale's, not the page's (day first on a
    // Mac set to Australia; others ask month or year first), so the order is
    // read from a field of the test's own. Amara has no date yet; Ingrid's is
    // 15 October 1979. Fictional people.
    test('a date of birth typed digit by digit is kept', async ({ page, baseURL, browserName }) => {
        test.skip(browserName !== 'chromium', "Chromium's typed date field; iOS hands over whole dates");
        const saved = () =>
            page.evaluate(() => {
                const raw = localStorage.getItem('thalassa_settings_mirror::anonymous');
                const roster = raw ? JSON.parse(raw).settings?.vessel?.crewRoster : undefined;
                return (roster ?? []).map((row: { dateOfBirth?: string; age?: number }) => ({
                    dateOfBirth: row.dateOfBirth ?? null,
                    age: row.age ?? null,
                }));
            });
        await open(page, baseURL, { width: 390, height: 844, view: 'vessel', roster: true });
        await page.getByRole('button', { name: 'Settings', exact: true }).click({ timeout: 25_000 });
        await page.getByRole('button', { name: /^Open Vessel Profile settings/ }).click();

        // The order of the parts, from a field of the test's own, typed the same way.
        await page.evaluate(() => {
            const probe = Object.assign(document.createElement('input'), { type: 'date', id: 'date-order-probe' });
            document.body.append(probe);
        });
        const probe = page.locator('#date-order-probe');
        await probe.focus();
        await probe.pressSequentially('02032001', { delay: 20 });
        type Order = 'dmy' | 'mdy' | 'ymd';
        const orders: Record<string, Order> = { '2001-03-02': 'dmy', '2001-02-03': 'mdy' };
        const order: Order = orders[await probe.inputValue()] ?? 'ymd';
        await probe.evaluate((element) => element.remove());
        const type = async (parts: string[]) => {
            for (const part of parts) {
                await page.keyboard.type(part, { delay: 30 });
                // A year waits for more digits; the day and month move on by themselves.
                if (part.length === 4 && part !== parts[parts.length - 1]) await page.keyboard.press('Tab');
            }
        };
        const inOrder = (day: string, month: string, year: string) =>
            order === 'dmy' ? [day, month, year] : order === 'mdy' ? [month, day, year] : [year, month, day];

        // A new date, every digit typed.
        const amara = page.getByLabel('Crew 3 date of birth', { exact: true });
        await amara.focus();
        await type(inOrder('15', '10', '1979'));
        await expect(amara).toHaveValue('1979-10-15');
        await expect.poll(async () => (await saved())[2]?.dateOfBirth).toBe('1979-10-15');

        // Its first part retyped: blank for a moment, and the saved date stays.
        const ingrid = page.getByLabel('Skipper date of birth', { exact: true });
        await ingrid.focus();
        await page.keyboard.press('Backspace');
        await expect(ingrid).toHaveValue('');
        await page.waitForTimeout(250);
        expect((await saved())[0]?.dateOfBirth, 'a part being retyped is not a cleared date').toBe('1979-10-15');
        const retypes: Record<Order, [string, string]> = {
            dmy: ['20', '1979-10-20'],
            mdy: ['11', '1979-11-15'],
            ymd: ['1980', '1980-10-15'],
        };
        const [first, retyped] = retypes[order];
        await page.keyboard.type(first, { delay: 30 });
        await expect(ingrid).toHaveValue(retyped);
        await expect.poll(async () => (await saved())[0]?.dateOfBirth).toBe(retyped);

        // Every part emptied and the field left: cleared, with the age it gave.
        // (Left and come back to, so typing starts at the first part again.)
        await ingrid.blur();
        await expect.poll(async () => (await saved())[0]?.dateOfBirth).toBe(retyped);
        await ingrid.focus();
        for (let part = 0; part < 3; part++) {
            await page.keyboard.press('Backspace');
            await page.keyboard.press('Tab');
        }
        // Emptying the last part fires nothing, and the third Tab only reaches
        // the field's own calendar button: leaving the field is the word.
        await expect(ingrid).toBeFocused();
        expect((await saved())[0]?.dateOfBirth, 'still saved until the field is left').toBe(retyped);
        await page.keyboard.press('Tab');
        await expect(ingrid).not.toBeFocused();
        await expect(ingrid).toHaveValue('');
        await expect.poll(async () => (await saved())[0]).toEqual({ dateOfBirth: null, age: null });
        expect((await saved())[2]?.dateOfBirth, "Amara's date is untouched").toBe('1979-10-15');
    });

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

/*
 * Skipper's Reference (132-B23, binder audit SR-3, SR-4) is in the house
 * shell: PageHeader with the Boat Binder crumb, inside the GPX import page's
 * shell. Its hub is a menu page: the intro and four cards fit one screen and
 * fill it, the last card ending 16 px above the tab bar (or the pane's edge);
 * Back is the 44 pt chevron named for the binder, straight under the app
 * header with no band of its own. A card page scrolls, and its last line,
 * the sources, scrolls clear of the bar and its fade instead of sitting under
 * them.
 */
const REFERENCE_CARDS = [
    'GRIB in 60 Seconds',
    'Synoptic Chart Decoder',
    'Marine Forecast Decoder',
    'Squalls & Cyclone-Season Rules',
];

async function openReference(page: Page) {
    await page.getByRole('button', { name: 'Boat Binder', exact: true }).click({ timeout: 25_000 });
    await page.getByRole('button', { name: "Skipper's Reference", exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: "Skipper's Reference" })).toBeVisible();
}

test.describe("Skipper's Reference", () => {
    for (const size of [...PHONES, ...PANES.slice(0, 3)]) {
        test(`the hub fits one screen at ${size.name}`, async ({ page, baseURL }) => {
            await open(page, baseURL, { ...size, view: 'vessel', split: size.width >= 1024 });
            await openReference(page);
            await settle(page);
            await noScroll(page, '.skipper-ref-hub');
            const limit = await floor(page);
            const cards = await wholeRows(page, '.skipper-ref-card', limit);
            expect(cards.map((card) => card.name)).toEqual(REFERENCE_CARDS);
            const gap = limit - cards.at(-1)!.bottom;
            expect(gap, `the last card ends ${gap}px above the floor`).toBeGreaterThanOrEqual(-0.5);
            expect(gap, `the last card ends ${gap}px above the floor`).toBeLessThanOrEqual(18.5);
            const back = (await page.getByRole('button', { name: 'Back to Boat Binder', exact: true }).boundingBox())!;
            expect(back.height, 'Back is a 44 pt target').toBeGreaterThanOrEqual(44 - 0.5);
            expect(back.width, 'Back is a 44 pt target').toBeGreaterThanOrEqual(44 - 0.5);
            // The page's header starts where the app header (or the pane's
            // frame, inside its 1 px border) ends: no notch band of its own.
            const band = await page.evaluate(() => {
                const pane = document.querySelector('[data-split-pane="page"]');
                const top = (pane ?? document.querySelector('header')!).getBoundingClientRect()[
                    pane ? 'top' : 'bottom'
                ];
                return document.querySelector('[data-page-header]')!.getBoundingClientRect().top - top;
            });
            expect(band, `the page header sits ${band}px under the app header`).toBeGreaterThanOrEqual(-0.5);
            expect(band, `the page header sits ${band}px under the app header`).toBeLessThanOrEqual(1.5);
        });
    }

    for (const size of [
        { name: 'SE +insets', width: 375, height: 662 },
        { name: '6.1in Display Zoom +insets', width: 320, height: 627 },
        { name: 'Pro Max +insets', width: 430, height: 856 },
        { name: '1080x810 split +insets', width: 1080, height: 782, split: true },
    ]) {
        test(`a card's last line scrolls clear of the tab bar at ${size.name}`, async ({ page, baseURL }) => {
            await open(page, baseURL, { ...size, view: 'vessel' });
            await openReference(page);
            const title = 'Squalls & Cyclone-Season Rules';
            await page.getByRole('button', { name: title, exact: true }).click();
            await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
            await settle(page);
            await page
                .locator('.skipper-ref-scroll')
                .evaluate((scroller) => scroller.scrollTo({ top: scroller.scrollHeight }));
            const limit = await floor(page);
            // Clear of the floor and of the 14 px fade above it.
            await expect
                .poll(async () => {
                    const box = (await page.locator('.skipper-ref-body > p').last().boundingBox())!;
                    return box.y + box.height;
                })
                .toBeLessThanOrEqual(limit - 14 + 0.5);
            // Back goes to the hub, and its chevron says so.
            await page.getByRole('button', { name: "Back to Skipper's Reference", exact: true }).click();
            await expect(page.getByRole('heading', { level: 1, name: "Skipper's Reference" })).toBeVisible();
        });
    }
});

/*
 * The Boat Binder and the Settings menu FILL their screen, and their words grow
 * with the room (Shane 2026-10-09, with a screenshot of the Binder on his
 * phone: "i think the words can be bigger also and take up the whole screen
 * claude. same goes for the settings main page"). The rows share the height
 * left under them evenly and end where the Vessel page's menu box does, ~16 pt
 * above the tab bar; the title, subtitle and icon grow from today's size (13 px
 * on a hub row, text-sm on a Settings row) to a cap, so an SE is unchanged.
 * A long home port away from Australia rides along in Preferences' state.
 */
const HOME_PORT = 'Las Palmas de Gran Canaria, Spain';

const MENU_PAGES = {
    'Boat Binder': {
        async open(page: Page) {
            await page.getByRole('button', { name: 'Boat Binder', exact: true }).click({ timeout: 25_000 });
            await expect(page.getByRole('heading', { level: 1, name: 'Boat Binder' })).toBeVisible();
        },
        scroller: '.vessel-binder-port',
        rows: '.vessel-binder-port .hub-row',
        title: '.hub-row-label',
        /** Today's title: OfficeRow's text-[13px]. */
        today: { px: 13, rem: 0 },
    },
    'Settings menu': {
        async open(page: Page) {
            await page.getByRole('button', { name: 'Settings', exact: true }).click({ timeout: 25_000 });
            await expect(page.getByRole('button', { name: /^Open Preferences settings/ })).toBeVisible();
        },
        scroller: '.settings-menu-screen .thalassa-scroll-fade',
        rows: '.settings-menu-row',
        title: '.settings-menu-title',
        /** Today's title: text-sm, 0.875 of the fluid root. */
        today: { px: 0, rem: 0.875 },
    },
} as const;
type MenuPage = (typeof MENU_PAGES)[keyof typeof MENU_PAGES];

/** Each row as drawn: its height, the height its content needs, its title's
 *  size, and what is cut: the row itself, and with `lines` every line in it.
 *  A home port or boat name may ellipsise by design, and on a short screen a
 *  subtitle keeps today's one line; every other line must read whole. */
async function menuRows(page: Page, menu: MenuPage, lines = false) {
    return page.locator(menu.rows).evaluateAll(
        (rows, { title, lines }) =>
            rows.map((row) => {
                const style = getComputedStyle(row);
                const content = Math.max(
                    ...[...row.children].map((child) => {
                        const own = getComputedStyle(child);
                        return (
                            child.getBoundingClientRect().height +
                            parseFloat(own.marginTop) +
                            parseFloat(own.marginBottom)
                        );
                    }),
                );
                const natural =
                    content +
                    parseFloat(style.paddingTop) +
                    parseFloat(style.paddingBottom) +
                    parseFloat(style.borderTopWidth) +
                    parseFloat(style.borderBottomWidth);
                const name = row.getAttribute('aria-label') ?? '';
                const freeText = /^Open (Preferences|Vessel Profile) settings/.test(name);
                const cut = [row, ...(lines ? row.querySelectorAll('span, p, div') : [])]
                    .filter((element) => !(freeText && element.matches('p.truncate')))
                    .filter((element) => element.scrollWidth > element.clientWidth + 1)
                    .map((element) => `${element.className} "${element.textContent?.trim()}"`);
                return {
                    name,
                    height: row.getBoundingClientRect().height,
                    bottom: row.getBoundingClientRect().bottom,
                    /** The bottom of the card the row sits in. */
                    card: row.parentElement!.getBoundingClientRect().bottom,
                    natural,
                    title: parseFloat(getComputedStyle(row.querySelector(title)!).fontSize),
                    cut,
                };
            }),
        { title: menu.title, lines },
    );
}

/** Today's title size, in px, under this page's fluid root. */
async function todayTitle(page: Page, menu: MenuPage) {
    const root = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    return menu.today.px + menu.today.rem * root;
}

const FILL_SIZES = [
    { name: 'SE', width: 375, height: 667, grows: false },
    { name: '6.1in Display Zoom +insets', width: 320, height: 627, grows: false },
    { name: '6.1in Pro +insets', width: 393, height: 775, grows: true },
    { name: '390x844', width: 390, height: 844, grows: true },
    // Shane's phone: the browser's 430x932, and the page the app really has
    // on it once the status bar and home indicator are taken.
    { name: '430x932', width: 430, height: 932, grows: true, big: true },
    { name: 'Pro Max +insets', width: 430, height: 856, grows: true, big: true },
    { name: '16 Pro Max +insets', width: 440, height: 876, grows: true, big: true },
    { name: '1024x768 split', width: 1024, height: 768, grows: true },
    { name: '1080x810 split +insets', width: 1080, height: 782, grows: true },
];

test.describe('menu pages fill their screen with bigger words', () => {
    for (const [label, menu] of Object.entries(MENU_PAGES)) {
        for (const size of FILL_SIZES) {
            test(`${label} fills its screen at ${size.name}`, async ({ page, baseURL }) => {
                await open(page, baseURL, { ...size, view: 'vessel', split: size.width >= 1024, home: HOME_PORT });
                await menu.open(page);
                await settle(page);
                await noScroll(page, menu.scroller);
                const limit = await floor(page);
                await wholeRows(page, menu.rows, limit);
                const rows = await menuRows(page, menu, size.grows);
                // The last card ends about where the Vessel page's menu box
                // does (the root's 8 px and 0.5rem above the bar, less on a
                // short screen); Settings' 1rem is the same ~16 pt.
                const gap = limit - rows.at(-1)!.card;
                expect(gap, `the last card ends ${gap}px above the floor`).toBeGreaterThanOrEqual(-0.5);
                expect(gap, `the last card ends ${gap}px above the floor`).toBeLessThanOrEqual(18.5);
                // The rows share the height left over evenly: each is its
                // content plus the same share.
                const extra = rows.map((row) => row.height - row.natural);
                expect(Math.max(...extra) - Math.min(...extra), `extra per row ${extra}`).toBeLessThanOrEqual(1.5);
                const today = await todayTitle(page, menu);
                for (const row of rows) {
                    expect(row.cut, `${row.name} is cut`).toEqual([]);
                    expect(row.title, `${row.name}'s title never goes giant`).toBeLessThanOrEqual(19 + 0.01);
                    if (!size.grows) expect(row.title, `${row.name}'s title is today's`).toBeCloseTo(today, 2);
                    else
                        expect(row.title, `${row.name}'s title floors at today's`).toBeGreaterThanOrEqual(today - 0.01);
                    if (size.big) expect(row.title, `${row.name}'s title on Shane's phone`).toBeGreaterThanOrEqual(17);
                }
            });
        }

        test(`${label} keeps today's type at 320x568 and reaches every row by scrolling`, async ({ page, baseURL }) => {
            // Known short, as the Vessel page is there: the app header leaves
            // ~430 px and the page needs ~490. The SE at Display Zoom keeps
            // today's page exactly; every row still scrolls clear of the bar.
            await open(page, baseURL, { width: 320, height: 568, view: 'vessel', home: HOME_PORT });
            await menu.open(page);
            await settle(page);
            const today = await todayTitle(page, menu);
            for (const row of await menuRows(page, menu)) {
                expect(row.height, `${row.name} is a 44 pt target`).toBeGreaterThanOrEqual(44 - 0.5);
                expect(row.title, `${row.name}'s title is today's`).toBeCloseTo(today, 2);
            }
            await page.locator(menu.scroller).evaluate((scroller) => scroller.scrollTo({ top: scroller.scrollHeight }));
            const limit = await floor(page);
            await expect.poll(async () => (await menuRows(page, menu)).at(-1)!.bottom).toBeLessThanOrEqual(limit);
        });

        test(`${label} fills its screen in daylight on Shane's phone`, async ({ page, baseURL }) => {
            await open(page, baseURL, { width: 430, height: 856, view: 'vessel', mode: 'light', home: HOME_PORT });
            await menu.open(page);
            await settle(page);
            await noScroll(page, menu.scroller);
            const limit = await floor(page);
            await wholeRows(page, menu.rows, limit);
            const gap = limit - (await menuRows(page, menu)).at(-1)!.card;
            expect(gap).toBeGreaterThanOrEqual(-0.5);
            expect(gap).toBeLessThanOrEqual(18.5);
        });
    }

    // The Vessel page's menu rows are the same row, so they take the same
    // type: the three menus read alike. Its room is shared with the Diary pair,
    // which must still stack its cards where it did, and "NMEA Gateway" keeps
    // one line beside "Not connected".
    for (const size of FILL_SIZES.filter((size) => size.width < 1024 && size.grows)) {
        test(`the Vessel page's menu takes the same bigger words at ${size.name}`, async ({ page, baseURL }) => {
            await open(page, baseURL, { ...size, view: 'vessel' });
            await expect(page.getByRole('button', { name: 'Open Diary', exact: true })).toBeVisible({
                timeout: 25_000,
            });
            await settle(page);
            await noScroll(page, '.vessel-hub-port');
            const limit = await floor(page);
            await wholeRows(page, MENU_ROWS, limit);
            await filled(page, limit);
            const vessel = await page.evaluate(() => {
                const label = (name: string) =>
                    document.querySelector(`[aria-label="${name}"] .hub-row-label`) as HTMLElement;
                const nmea = label('NMEA Gateway');
                return {
                    title: parseFloat(getComputedStyle(nmea).fontSize),
                    nmeaLines: Math.round(
                        nmea.getBoundingClientRect().height / parseFloat(getComputedStyle(nmea).lineHeight),
                    ),
                    stacked: getComputedStyle(document.querySelector('.vessel-hub-tile-go')!).visibility === 'visible',
                };
            });
            // The crew card's row is a menu row: the same grown title.
            const crewTitle = await page
                .locator('[aria-label="Crew & Float Plan"] .hub-row-label')
                .evaluate((label) => parseFloat(getComputedStyle(label).fontSize));
            expect(crewTitle).toBeCloseTo(vessel.title, 2);
            expect(vessel.title).toBeGreaterThanOrEqual(13);
            expect(vessel.title).toBeLessThanOrEqual(19 + 0.01);
            expect(vessel.nmeaLines, '"NMEA Gateway" keeps one line').toBe(1);
            expect(vessel.stacked, 'the Diary pair still stacks its cards').toBe(true);
            if (size.big) expect(vessel.title, "the menu's title on Shane's phone").toBeGreaterThanOrEqual(17);
        });
    }

    // A fresh install's "Set up your vessel" card (and its sign-in line)
    // already makes the Vessel page scroll on a big phone: its rows get no
    // share of the height, so growing their words would only make it scroll
    // further. They keep today's size until the boat has a name (the plan:
    // "keep its floor"; review 2026-10-09 measured +37 px of scroll at 430x856).
    for (const size of FILL_SIZES.filter((size) => size.width < 1024 && size.grows)) {
        test(`a fresh install's Vessel page keeps today's words at ${size.name}`, async ({ page, baseURL }) => {
            await open(page, baseURL, { ...size, view: 'vessel', fresh: true });
            await expect(page.getByRole('button', { name: 'Set up your vessel', exact: true })).toBeVisible({
                timeout: 25_000,
            });
            await settle(page);
            const rows = await page.locator(MENU_ROWS).evaluateAll((rows) =>
                rows.map((row) => ({
                    name: row.getAttribute('aria-label'),
                    height: row.getBoundingClientRect().height,
                    title: parseFloat(getComputedStyle(row.querySelector('.hub-row-label')!).fontSize),
                    status: parseFloat(getComputedStyle(row.querySelector('.hub-row-status')!).fontSize),
                    icon: row.querySelector('.hub-row-icon svg')!.getBoundingClientRect().height,
                })),
            );
            // Today's subtitle: text-xs, never under the 12 px micro floor.
            const root = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
            expect(rows.map((row) => row.name)).toEqual(ORDER);
            for (const row of rows) {
                expect(row.title, `${row.name}'s title is today's`).toBeCloseTo(13, 2);
                expect(row.status, `${row.name}'s subtitle is today's`).toBeCloseTo(Math.max(0.75 * root, 12), 2);
                expect(row.icon, `${row.name}'s icon is today's`).toBeCloseTo(root, 1);
                expect(row.height, `${row.name} is a 44 pt target`).toBeGreaterThanOrEqual(44 - 0.5);
            }
        });
    }

    // A Settings row's live state that no longer fits beside its grown title
    // takes the line under it, whole, but keeps to the right-hand column where
    // its siblings' states sit, so it reads as the row's state and not as a
    // second grey subtitle over the description (review 2026-10-09). That is
    // the rule for free text, a home port or a boat name, and a long home port
    // always drops. A fixed state word ("Sign in", "Off", "3 alerts on") is
    // short enough to stay on the title line since 126-14, and does, in the
    // widest face too.
    for (const size of FILL_SIZES.filter((size) => size.width < 1024 && size.grows)) {
        test(`a Settings row's live state keeps to the right-hand column at ${size.name}`, async ({
            page,
            baseURL,
        }) => {
            const menu = MENU_PAGES['Settings menu'];
            await open(page, baseURL, { ...size, view: 'vessel', home: HOME_PORT });
            await menu.open(page);
            await settle(page);
            const states = await page.locator(menu.rows).evaluateAll((rows) =>
                rows.flatMap((row) => {
                    const line = row.querySelector('.settings-menu-line')!.getBoundingClientRect();
                    const title = row.querySelector('.settings-menu-title')!.getBoundingClientRect();
                    const state = row.querySelector('.settings-menu-line > .settings-menu-title + p');
                    if (!state) return [];
                    const box = state.getBoundingClientRect();
                    return [
                        {
                            name: row.getAttribute('aria-label'),
                            word: state.classList.contains('settings-menu-state--word'),
                            dropped: box.top >= title.bottom - 1,
                            short: line.right - box.right,
                        },
                    ];
                }),
            );
            expect(states.length).toBeGreaterThanOrEqual(3);
            expect(
                states.find((state) => state.name?.startsWith('Open Preferences settings'))?.dropped,
                'the long home port takes the line under "Preferences"',
            ).toBe(true);
            for (const state of states) {
                expect(
                    Math.abs(state.short),
                    `${state.name}: its state ends ${state.short}px short`,
                ).toBeLessThanOrEqual(1);
                if (state.word) expect(state.dropped, `${state.name}: its word stays on the title line`).toBe(false);
            }
        });
    }

    // 126-14: every fixed state word sits WHOLE on its title's line: from the
    // SE up and in the iPad's split pane, in the widest face. The fixture is
    // signed out, so the rows really say "Sign in"; the words a row shows
    // signed in ("Signed in", "Live", "12 alerts on") are proven by setting the
    // state's text in place and measuring again. That is a layout probe, not
    // a state the app reached. On a 320 pt phone a word with no room beside
    // "Public Voyage Page" is left off the line entirely (VoiceOver still hears
    // it in the row's name): whole or gone, never cut, never "Ne...".
    const WORD_SIZES = [
        { name: 'SE', width: 375, height: 667 },
        { name: '390x844', width: 390, height: 844 },
        { name: '6.1in Pro +insets', width: 393, height: 775 },
        { name: '430x932', width: 430, height: 932 },
        { name: 'Pro Max +insets', width: 430, height: 856 },
        { name: '16 Pro Max +insets', width: 440, height: 876 },
        { name: '1024x768 split', width: 1024, height: 768 },
        { name: '1080x810 split +insets', width: 1080, height: 782 },
        { name: 'SE Display Zoom', width: 320, height: 568, narrow: true },
        { name: '6.1in Display Zoom +insets', width: 320, height: 627, narrow: true },
    ];
    for (const size of WORD_SIZES) {
        test(`Settings' state words are whole on the title line${size.narrow ? ' or off it' : ''} at ${size.name}`, async ({
            page,
            baseURL,
        }) => {
            const menu = MENU_PAGES['Settings menu'];
            await open(page, baseURL, { ...size, view: 'vessel', split: size.width >= 1024, home: HOME_PORT });
            await menu.open(page);
            await settle(page);
            const measured = await page.locator(menu.rows).evaluateAll(
                (rows, vocabulary) => {
                    const rowIds: Record<string, string> = {
                        account: 'Open Account & Cloud settings',
                        voyageLog: 'Open Public voyage page settings',
                        alerts: 'Open Notifications settings',
                        locations: 'Open Locations settings',
                    };
                    const measure = (row: Element, state: HTMLElement) => {
                        const line = row.querySelector('.settings-menu-line')!.getBoundingClientRect();
                        const title = row.querySelector('.settings-menu-title')!.getBoundingClientRect();
                        const box = state.getBoundingClientRect();
                        return {
                            name: row.getAttribute('aria-label'),
                            text: state.textContent,
                            word: state.classList.contains('settings-menu-state--word'),
                            onLine:
                                box.top < title.bottom &&
                                box.bottom <= line.bottom + 0.5 &&
                                box.right <= line.right + 1 &&
                                box.left >= title.right - 0.5,
                            hidden: box.top >= line.bottom - 0.5,
                            cut: state.scrollWidth > state.clientWidth + 1,
                            ellipsis: getComputedStyle(state).textOverflow === 'ellipsis',
                            missing: false,
                        };
                    };
                    const live = rows.flatMap((row) => {
                        const state = row.querySelector<HTMLElement>('.settings-menu-line > .settings-menu-title + p');
                        return state && state.classList.contains('settings-menu-state--word')
                            ? [measure(row, state)]
                            : [];
                    });
                    const swept = Object.entries(vocabulary).flatMap(([id, words]) => {
                        const row = rows.find((row) => row.getAttribute('aria-label')?.startsWith(rowIds[id]));
                        const state = row?.querySelector<HTMLElement>('.settings-menu-line > .settings-menu-title + p');
                        if (!row || !state) {
                            const none = { name: rowIds[id], text: '', word: false, onLine: false, hidden: false };
                            return [{ ...none, cut: false, ellipsis: false, missing: true }];
                        }
                        const was = state.textContent;
                        const out = words.map((word) => {
                            state.textContent = word;
                            return measure(row, state);
                        });
                        state.textContent = was;
                        return out;
                    });
                    return { live, swept };
                },
                SETTINGS_STATE_WORDS as unknown as Record<string, string[]>,
            );
            // Signed out: Account & Cloud and the Public Voyage Page say "Sign in".
            expect(measured.live.filter((state) => state.text === 'Sign in')).toHaveLength(2);
            for (const state of [...measured.live, ...measured.swept]) {
                const label = `${state.name} "${state.text}"`;
                expect(state.missing, `${label} has a state to measure`).toBe(false);
                if (state.missing) continue;
                expect(state.word, `${label} is a fixed word`).toBe(true);
                expect(state.cut, `${label} is never cut`).toBe(false);
                expect(state.ellipsis, `${label} never ellipsises`).toBe(false);
                if (size.narrow)
                    expect(state.onLine || state.hidden, `${label} is whole on the line or off it`).toBe(true);
                else expect(state.onLine, `${label} is whole on its title's line`).toBe(true);
            }
            if (!size.narrow) await wholeRows(page, menu.rows, await floor(page));
            else {
                // The clip itself, probed with the old long word, which was cut to
                // "Needs si..." here: now it is wholly off the line, none of it drawn.
                const probe = await page
                    .getByRole('button', { name: /^Open Public voyage page settings/ })
                    .evaluate((row) => {
                        const state = row.querySelector<HTMLElement>('.settings-menu-state--word')!;
                        const was = state.textContent;
                        state.textContent = 'Needs sign-in';
                        const line = row.querySelector('.settings-menu-line')!.getBoundingClientRect();
                        const box = state.getBoundingClientRect();
                        state.textContent = was;
                        return { hidden: box.top >= line.bottom - 0.5, cut: state.scrollWidth > state.clientWidth + 1 };
                    });
                expect(probe, '"Needs sign-in" is off the line, whole, never cut').toEqual({
                    hidden: true,
                    cut: false,
                });
            }
        });
    }

    test('a Settings search keeps its rows at their own height, never stretched to the page', async ({
        page,
        baseURL,
    }) => {
        const menu = MENU_PAGES['Settings menu'];
        await open(page, baseURL, { width: 430, height: 932, view: 'vessel', home: HOME_PORT });
        await menu.open(page);
        await settle(page);
        await page.getByRole('searchbox', { name: 'Search settings' }).fill('alerts');
        await expect(page.locator(menu.rows)).toHaveCount(1);
        await settle(page);
        const [row] = await menuRows(page, menu, true);
        expect(row.name).toMatch(/^Open Notifications settings/);
        expect(Math.abs(row.height - row.natural), `${row.height} vs ${row.natural}`).toBeLessThanOrEqual(1.5);
        expect(await floor(page)).toBeGreaterThan(row.bottom + 200);
        expect(row.cut).toEqual([]);
    });
});

test.describe('split-pane front doors', () => {
    for (const size of PANES) {
        test(`Route Planner front door fits its pane at ${size.name}`, async ({ page, baseURL }) => {
            await open(page, baseURL, { ...size, view: 'voyage', split: true, trip: true });
            await expect(page.locator('.route-planner-cta > div')).toBeVisible({ timeout: 25_000 });
            // The Trip · Legs tile (a button since 126-16a; it opens the Trip sheet).
            await expect(page.getByRole('button', { name: 'Trip · Legs', exact: true })).toBeVisible();
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
