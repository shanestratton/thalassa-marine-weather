import { expect, test, type Page } from '@playwright/test';
import { applyWideFonts, expectWideFaceDrawn } from '../e2e/helpers/wideFonts';

/**
 * Plan Your Day routes the stop she opens (build 127, 127-PYD-2), measured on
 * the real sheet, engine and loader over synthetic sources
 * (e2e/fixtures/day-planner.tsx), under the app's tab bar, in wide fonts.
 *
 * Shane, 2026-10-10: "when you select somewhere, and plot on the chart. it
 * goes direct. straight over hills. rocks, other boats, land, sea, air, you
 * name it … so can we incorporate the autorouting into the plan your day
 * thingy." His decisions that day: his account only in 127 (?owner=1, a
 * fictional account here), a "Route round the land" tap, and the routing time
 * shown to him ("Routed in 6.4 s · router 4.1 s").
 *
 * The provider is the fixture's fake behind the real routeStop: a synthetic
 * line bent between her pins, no network, its stages held so the sheet can be
 * scrolled while it routes. The stop page with the route row and the timing
 * line fits without a scroll at 375 x 667, 390 x 844 and 430 x 932 as the
 * app draws them, and so does a reviewed stop with one of Auto's long
 * refusals (to 205 characters) at 375 x 667; at 320 x 568 it may scroll inside the card
 * with its level, route row and times in view (132-PYD-8: the stop page is a plan, the
 * route row under its level). The draft modal, when it asks, sits on
 * top of the stop page, centred clear of the tab bar. A tester sees no route
 * row anywhere. Nouméa and Tromsø say why there is no route in global words,
 * never a blank row, never "Pi". The routing cases of 127-PYD-2, 3 and 11 live
 * here, apart from screen 1's spec (127-PYD-common, "the serial file").
 *
 * 127-PYD-3: routed, the main button is "Show route on chart": Auto's chart
 * opens over Plan Your Day (its sheet hidden behind it, the tab bar under it),
 * Back returns to the same stop page, and "Use on the main chart" hands the
 * chart the routed line, never a straight one. With no route, or for a
 * tester, "Plot by hand" hands it two marks and no pins.
 *
 * 132-PYD-9: the stop page's picture of the way draws no line while it is not
 * routed, and the provider's own line once it is, in the room the plan leaves.
 */

test.use({ timezoneId: 'Europe/London' });

type Size = { name: string; width: number; height: number; query: string };
/** As day-planner-layout.spec.ts draws them: each sheet gets the room it gets on the phone. */
const AS_DRAWN: Record<'se' | 'se2' | 'mid' | 'shane', Size> = {
    se: { name: '320x568 as drawn', width: 320, height: 561, query: '&root=app' },
    se2: { name: '375x667 as drawn', width: 375, height: 662, query: '&root=app' },
    mid: { name: '390x844 as drawn', width: 390, height: 779, query: '&root=app' },
    shane: { name: '430x932 as drawn', width: 430, height: 856, query: '&root=app' },
};
const OTHER: Size[] = [
    { name: '844x390 landscape', width: 844, height: 390, query: '' },
    { name: '1024x768 split pane', width: 1024, height: 768, query: '&pane=true' },
    { name: 'large text 390x844', width: 390, height: 844, query: '&largeText' },
];
const TIMING = 'Routed in 6.4 s · router 4.1 s';
// With the leave row under it (127-PYD-11), his timing joins the route row: the page still fits.
const ROUTED = /^Routed on your charts · 16\.5 NM each way · 0\.3 NM shallow · Routed in 6\.4 s · router 4\.1 s$/;

async function open(page: Page, size: { width: number; height: number }, query: string) {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(url.hostname) && route.request().method() === 'GET'
            ? route.continue()
            : route.abort();
    });
    await applyWideFonts(page);
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(`/e2e/fixtures/day-planner.html?${query.replace(/^&/, '')}`);
    const dialog = page.getByRole('dialog', { name: 'Plan Your Day', exact: true });
    await expect(dialog).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expectWideFaceDrawn(dialog.getByRole('heading', { name: 'Plan Your Day' }));
    return errors;
}

/** Opens the first card stop once its times are in; returns the stop page. */
async function openStop(page: Page) {
    const dialog = page.getByRole('dialog', { name: 'Plan Your Day', exact: true });
    const first = dialog.getByRole('list', { name: 'Stops' }).getByRole('button').first();
    await expect(first.locator('.today-stop-l2')).toHaveText(/^\d\d:\d\d → \d\d:\d\d · /);
    await first.click();
    const detail = page.locator('.today-detail');
    // The way: the distance, and the route row where routing is offered (132-PYD-8 puts it under the level).
    await expect(detail.getByRole('list', { name: 'The way' })).toBeVisible();
    return detail;
}

/** The stop page's house rules, measured in the page: centred, clear of the tab bar, nothing clipped. */
function layoutIssues(page: Page, mayScroll: boolean) {
    return page.evaluate((mayScroll) => {
        const issues: string[] = [];
        const card = document.querySelector<HTMLElement>('.today-detail');
        const overlay = card?.parentElement;
        if (!card || !overlay) return ['no stop page'];
        const box = card.getBoundingClientRect();
        const lay = overlay.getBoundingClientRect();
        const pad = getComputedStyle(overlay);
        const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
        const left = box.left - (lay.left + parseFloat(pad.paddingLeft));
        const right = lay.right - parseFloat(pad.paddingRight) - box.right;
        const above = box.top - (lay.top + parseFloat(pad.paddingTop));
        const below = lay.bottom - parseFloat(pad.paddingBottom) - box.bottom;
        if (Math.abs(left - right) > 2) issues.push(`not centred across: ${left} vs ${right}`);
        if (Math.abs(above - below) > 2) issues.push(`not centred down: ${above} vs ${below}`);
        // 1rem clear of the tab bar's 4rem row, as the overlay pads it: 13 px at an SE's fluid root, 16 at a fixed one.
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
        if (box.bottom > nav.top + 1 - rem + 0.5)
            issues.push(`card bottom ${box.bottom} within ${rem} px of the tab bar ${nav.top}`);
        if (box.top < 0 || box.left < 0 || box.right > innerWidth + 0.5) issues.push('card off screen');
        const body = card.querySelector<HTMLElement>('.today-body')!;
        if (!mayScroll && body.scrollHeight - body.clientHeight > 1)
            issues.push(`body scrolls by ${body.scrollHeight - body.clientHeight}px at ordinary text`);
        for (const selector of ['.today-head', '.today-actions']) {
            const r = card.querySelector(selector)!.getBoundingClientRect();
            if (r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5) issues.push(`${selector} is clipped`);
        }
        for (const control of card.querySelectorAll<HTMLElement>('button')) {
            const r = control.getBoundingClientRect();
            if (r.width < 44 - 0.5 || r.height < 44 - 0.5)
                issues.push(`${control.textContent?.trim()} is ${r.width}×${r.height}`);
        }
        // No row is cut sideways: every line of the rows wraps inside the card.
        for (const row of card.querySelectorAll<HTMLElement>('.today-rows li'))
            if (row.scrollWidth > row.clientWidth + 1) issues.push(`"${row.textContent}" is cut sideways`);
        if (document.documentElement.scrollWidth > innerWidth) issues.push('the page scrolls sideways');
        if (card.scrollWidth > card.clientWidth + 1) issues.push('the card overflows sideways');
        return issues;
    }, mayScroll);
}

async function routeIt(page: Page) {
    const detail = page.locator('.today-detail');
    await expect(detail.locator('li[data-route]')).toHaveText('Not routed yet: takes a few seconds.');
    await detail.getByRole('button', { name: 'Route round the land', exact: true }).click();
    return detail;
}

for (const size of [AS_DRAWN.se2, AS_DRAWN.mid, AS_DRAWN.shane])
    test(`the routed stop page with its timing line fits without a scroll at ${size.name}`, async ({ page }) => {
        const errors = await open(page, size, `&mode=routed&owner=1${size.query}`);
        await openStop(page);
        const detail = await routeIt(page);
        // "Finding the way…" is said before the result.
        await expect(detail.locator('li[data-route]')).toHaveText(/^Finding the way round the land/);
        await expect(detail.locator('li[data-route]')).toHaveText(ROUTED, { timeout: 10_000 });
        await expect(detail.getByText(TIMING, { exact: true })).toBeVisible();
        // The distance is said once: no estimate row beside the route row.
        await expect(detail.getByText(/NM each way \(/)).toHaveCount(0);
        await expect(detail.locator('.today-footnote')).toHaveText(/^Route from your charts: draft 2\.40 m/);
        expect(await layoutIssues(page, false)).toEqual([]);
        expect(errors).toEqual([]);
    });

// 132-PYD-9: never a straight line on the picture either: none until routed, then the provider's line (the
// fixture's three points: start, its bend, the stop), and the page still one screen.
test("the stop page's picture has no line until routed, then the routed line", async ({ page }) => {
    const errors = await open(page, AS_DRAWN.shane, `&mode=routed&owner=1${AS_DRAWN.shane.query}`);
    await openStop(page);
    const picture = page.locator('.today-detail .today-pic');
    await expect(picture.locator('svg[role="img"]')).toHaveAttribute('aria-label', /^Map: /);
    await expect(picture.locator('polyline, line')).toHaveCount(0);
    const detail = await routeIt(page);
    await expect(detail.locator('li[data-route]')).toHaveText(/^Finding the way round the land/);
    await expect(picture.locator('polyline, line')).toHaveCount(0);
    await expect(detail.locator('li[data-route]')).toHaveText(ROUTED, { timeout: 10_000 });
    await expect(picture.locator('polyline')).toHaveCount(1);
    expect((await picture.locator('polyline').getAttribute('points'))!.split(' ')).toHaveLength(3);
    await expect(picture.locator('svg[role="img"]')).toHaveAttribute('aria-label', /, the routed line, /);
    expect(await layoutIssues(page, false)).toEqual([]);
    expect(errors).toEqual([]);
});

test('at 320 x 568 as drawn the routed stop page may scroll inside its card, its level, route row and times in view', async ({
    page,
}) => {
    const errors = await open(page, AS_DRAWN.se, `&mode=routed&owner=1${AS_DRAWN.se.query}`);
    await openStop(page);
    const detail = await routeIt(page);
    await expect(detail.locator('li[data-route]')).toHaveText(ROUTED, { timeout: 10_000 });
    expect(await layoutIssues(page, true)).toEqual([]);
    // The plan (132-PYD-8): its level, the route row and the times big, as it opens.
    const inView = await page.evaluate(() => {
        const body = document.querySelector('.today-detail .today-body')!.getBoundingClientRect();
        return ['.today-level', 'li[data-route]', '.today-times'].map((sel) => {
            const r = document.querySelector(`.today-detail ${sel}`)!.getBoundingClientRect();
            return r.top >= body.top - 0.5 && r.bottom <= body.bottom + 0.5;
        });
    });
    expect(inView).toEqual([true, true, true]);
    expect(errors).toEqual([]);
});

test('while it routes the sheet scrolls and the page never stalls (a 4 ms heartbeat, no gap over 150 ms)', async ({
    page,
    browserName,
}) => {
    const errors = await open(page, OTHER[2], '&mode=routed&owner=1&largeText&hold=2500');
    await openStop(page);
    const detail = await routeIt(page);
    const row = detail.locator('li[data-route]');
    await expect(row).toHaveText(/^Routing round the land/, { timeout: 5_000 });
    await page.evaluate(() => {
        const beat = { last: performance.now(), worst: 0 };
        (window as unknown as { __beat: typeof beat }).__beat = beat;
        setInterval(() => {
            const now = performance.now();
            beat.worst = Math.max(beat.worst, now - beat.last);
            beat.last = now;
        }, 4);
    });
    const body = detail.locator('.today-body');
    const before = await body.evaluate((el) => el.scrollTop);
    // A wheel where the browser has one; mobile WebKit has none, so its body is scrolled as a flick would.
    if (browserName === 'chromium') {
        await body.hover();
        await page.mouse.wheel(0, 400);
    } else await body.evaluate((el) => el.scrollBy({ top: 400 }));
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(before);
    // The seconds tick, counted from the tap.
    await expect(row).toHaveText(/^Routing round the land · \d+ s$/);
    await expect(row).toHaveText(ROUTED, { timeout: 10_000 });
    const worst = await page.evaluate(() => (window as unknown as { __beat: { worst: number } }).__beat.worst);
    expect(worst).toBeLessThan(150);
    expect(errors).toEqual([]);
});

test('the draft modal, when it asks, is on top of the stop page and centred clear of the tab bar', async ({ page }) => {
    const errors = await open(page, AS_DRAWN.se2, `&mode=routed&owner=1&draft=ask${AS_DRAWN.se2.query}`);
    await openStop(page);
    const detail = await routeIt(page);
    const ask = page.locator('[data-draft-confirm]');
    await expect(ask).toBeVisible();
    const geometry = await page.evaluate(() => {
        const card = document.querySelector('[data-draft-confirm-card]')!.getBoundingClientRect();
        const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
        const hit = document.elementFromPoint(card.left + card.width / 2, card.top + card.height / 2);
        return {
            onTop: !!hit?.closest('[data-draft-confirm-card]'),
            across: Math.abs(card.left - (innerWidth - card.right)),
            clear: nav.top - card.bottom,
            rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
        };
    });
    expect(geometry.onTop).toBe(true);
    expect(geometry.across).toBeLessThanOrEqual(2);
    // At least the 1rem the house modal rule leaves above the tab bar.
    expect(geometry.clear).toBeGreaterThanOrEqual(geometry.rem - 0.5);
    await ask.getByRole('button', { name: /^Confirm / }).click();
    await expect(detail.locator('li[data-route]')).toHaveText(ROUTED, { timeout: 10_000 });
    expect(errors).toEqual([]);
});

for (const size of OTHER)
    test(`the routed stop page clips no row at ${size.name}`, async ({ page }) => {
        const errors = await open(page, size, `&mode=routed&owner=1${size.query}`);
        await openStop(page);
        const detail = await routeIt(page);
        await expect(detail.locator('li[data-route]')).toHaveText(ROUTED, { timeout: 10_000 });
        await detail.getByText(TIMING, { exact: true }).scrollIntoViewIfNeeded();
        await expect(detail.getByText(TIMING, { exact: true })).toBeInViewport();
        expect(await layoutIssues(page, true)).toEqual([]);
        expect(errors).toEqual([]);
    });

test('a tester sees no route row anywhere: the stop page is today’s', async ({ page }) => {
    const errors = await open(page, AS_DRAWN.mid, `&mode=routed${AS_DRAWN.mid.query}`);
    const detail = await openStop(page);
    await expect(detail.getByRole('button', { name: 'Plot by hand', exact: true })).toBeVisible();
    await expect(detail.locator('li[data-route]')).toHaveCount(0);
    await expect(detail.getByRole('button', { name: 'Route round the land' })).toHaveCount(0);
    expect(await page.locator('body').textContent()).not.toMatch(/round the land|Routed in/);
    expect(errors).toEqual([]);
});

test('Auto route (trial) off: the owner reads how to turn it on, and one tap turns it on in place', async ({
    page,
}) => {
    const errors = await open(page, AS_DRAWN.se2, `&mode=no-route&owner=1${AS_DRAWN.se2.query}`);
    const detail = await openStop(page);
    const link = detail.getByRole('button', { name: /^Turn on Auto route \(trial\) to route round the land\./ });
    await expect(link).toBeVisible();
    expect(await layoutIssues(page, false)).toEqual([]);
    await link.click();
    await expect(detail.locator('li[data-route]')).toHaveText('Not routed yet: takes a few seconds.');
    expect(errors).toEqual([]);
});

for (const [mode, words] of [
    // The coverage gate: no chart at the stop.
    ['no-chart', /^No chart for Fixture .+ on this phone: add charts for this area to route round the land\.$/],
    // Past it, with no Pi paired: both ends are charted, the gap is on the way.
    [
        'tromso',
        /^No chart on this phone for the way to Fixture .+: add charts for this area to route round the land\.$/,
    ],
] as const)
    test(`${mode === 'no-chart' ? 'Nouméa' : 'Tromsø'}: the honest no-chart words, never a blank row, never "Pi"`, async ({
        page,
    }) => {
        const errors = await open(page, AS_DRAWN.se2, `&mode=${mode}&owner=1${AS_DRAWN.se2.query}`);
        await openStop(page);
        const detail = await routeIt(page);
        const row = detail.locator('li[data-route]');
        await expect(row.locator('[aria-live]')).toHaveText(words, { timeout: 10_000 });
        expect(await row.textContent()).not.toMatch(/\bPi\b/);
        // The estimate stays, in the route row, and the timing says how long the no took.
        await expect(row.getByText(/^About \d+ NM each way/)).toBeVisible();
        await expect(detail.getByText(/NM each way \(/)).toHaveCount(1);
        await expect(detail.getByText(/^No route after 6\.4 s$/)).toBeVisible();
        await expect(detail.getByRole('button', { name: 'Plot by hand', exact: true })).toBeVisible();
        expect(await layoutIssues(page, false)).toEqual([]);
        expect(errors).toEqual([]);
    });

// Auto's long refusals, whole, on a reviewed stop (its local notes, and "Leaving a marina"): the
// charts-from-the-Pi sentence Shane gets with his Pi paired (149 characters) and a failed cloud fill at
// its longest (165), each beside the longest estimate ("straight line, longer round land",
// ?coast=ring), and a pin far from water with its harbour water not downloaded (205). Review finding
// 2026-10-11: with the estimate and the timing on rows of their own, the stop page had no room left.
for (const [refuse, estimate] of [
    ['bucket&pi=1&coast=ring', /^About \d+ NM each way \(straight line, longer round land\)$/],
    ['fill&coast=ring', /^About \d+ NM each way \(straight line, longer round land\)$/],
    ['pack', /^About \d+ NM each way \(estimate\)$/],
] as const)
    test(`a reviewed stop with Auto's long refusal (${refuse.split('&')[0]}) fits without a scroll at 375x667 as drawn`, async ({
        page,
    }) => {
        const errors = await open(page, AS_DRAWN.se2, `&mode=routed&owner=1&refuse=${refuse}${AS_DRAWN.se2.query}`);
        const detail = await openStop(page);
        await expect(detail.locator('li[data-parks]').first()).toBeVisible();
        await routeIt(page);
        const row = detail.locator('li[data-route="no-route"]');
        await expect(row.locator('[aria-live]')).toHaveText(/(Nothing changed|try again shortly)\.$/, {
            timeout: 10_000,
        });
        expect((await row.locator('[aria-live]').textContent())!.length).toBeGreaterThanOrEqual(145);
        await expect(detail.getByText(/^No route after 6\.4 s$/)).toBeVisible();
        expect(await layoutIssues(page, false)).toEqual([]);
        await expect(row.getByText(estimate)).toBeVisible();
        expect(errors).toEqual([]);
    });

// ── 127-PYD-3: the routed line on the chart, never a straight one ──

type Plotted = { kind: string; points: unknown[]; routed?: boolean; frame?: { why: string; to: { name: string } } };
const plotted = (page: Page) =>
    page.evaluate(
        () => (window as unknown as { __dayPlannerFixture: { plotted: Plotted[] } }).__dayPlannerFixture.plotted,
    );

for (const size of [AS_DRAWN.se, AS_DRAWN.mid, OTHER[1]])
    test(`routed: Show route on chart opens Auto's chart over the sheet and Back returns to the stop, at ${size.name}`, async ({
        page,
    }) => {
        const errors = await open(page, size, `&mode=routed&owner=1${size.query}`);
        await openStop(page);
        const detail = await routeIt(page);
        await expect(detail.locator('li[data-route]')).toHaveText(ROUTED, { timeout: 10_000 });
        const show = detail.getByRole('button', { name: 'Show route on chart', exact: true });
        await show.click();
        const chart = page.getByRole('dialog', { name: /^Plan Your Day route to / });
        await expect(chart).toBeVisible({ timeout: 15_000 });
        // Plan Your Day's own screens are hidden behind it, not just covered.
        await expect(page.locator('.today-overlay:visible')).toHaveCount(0);
        await expect(page.getByRole('dialog', { name: 'Plan Your Day', exact: true })).toBeHidden();
        // Its buttons are on top: never under the tab bar.
        for (const name of ['Use on the main chart', 'Back to Plan Your Day']) {
            const button = chart.getByRole('button', { name, exact: true });
            await button.scrollIntoViewIfNeeded();
            const onTop = await button.evaluate((node) => {
                const r = node.getBoundingClientRect();
                const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return !!hit && node.contains(hit) && r.bottom <= innerHeight + 0.5;
            });
            expect(onTop, name).toBe(true);
        }
        await chart.getByRole('button', { name: 'Back to Plan Your Day', exact: true }).click();
        await expect(chart).toHaveCount(0);
        // The same stop page, its route still in, focus on its main button.
        await expect(detail.locator('li[data-route]')).toHaveText(ROUTED);
        await expect(show).toBeFocused();
        expect(await layoutIssues(page, size.height < 640 || size.query.includes('largeText'))).toEqual([]);
        expect(errors).toEqual([]);
    });

test('Use on the main chart hands the chart the routed line out and back: more than two points, never straight', async ({
    page,
}) => {
    const errors = await open(page, AS_DRAWN.se2, `&mode=routed&owner=1${AS_DRAWN.se2.query}`);
    await openStop(page);
    const detail = await routeIt(page);
    await expect(detail.locator('li[data-route]')).toHaveText(ROUTED, { timeout: 10_000 });
    await detail.getByRole('button', { name: 'Show route on chart', exact: true }).click();
    const chart = page.getByRole('dialog', { name: /^Plan Your Day route to / });
    await chart.getByRole('button', { name: 'Use on the main chart', exact: true }).click();
    await expect(chart).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Plan Your Day', exact: true })).toHaveCount(0);
    const sent = await plotted(page);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'plot-day', routed: true });
    // The fixture's three-point line, there and back.
    expect(sent[0].points).toHaveLength(5);
    expect(sent[0].frame).toBeUndefined();
    expect(errors).toEqual([]);
});

for (const [who, query, why] of [
    // Nouméa, the owner: no chart at the stop, said in global words.
    ['the owner with no chart (Nouméa)', '&mode=no-chart&owner=1', /^No chart for Fixture .+ on this phone/],
    // The owner with Auto route (trial) off: what routing needs, and still never a line.
    [
        'the owner with Auto route off',
        '&mode=no-route&owner=1',
        /^Turn on Auto route \(trial\) to route round the land\.$/,
    ],
    // A tester: nothing about routing.
    ['a tester', '&mode=routed', /^$/],
] as const)
    test(`Plot by hand for ${who} hands the chart two marks and no pins`, async ({ page }) => {
        const errors = await open(page, AS_DRAWN.se2, `${query}${AS_DRAWN.se2.query}`);
        const detail = await openStop(page);
        if (query.includes('no-chart')) {
            await routeIt(page);
            await expect(detail.locator('li[data-route="no-route"]')).toBeVisible({ timeout: 10_000 });
        }
        await detail.getByRole('button', { name: 'Plot by hand', exact: true }).click();
        const sent = await plotted(page);
        expect(sent).toHaveLength(1);
        expect(sent[0].kind).toBe('plot-day');
        expect(sent[0].points).toHaveLength(0);
        expect(sent[0].routed).toBeUndefined();
        expect(sent[0].frame!.why).toMatch(why);
        expect(sent[0].frame!.to.name).toMatch(/\S/);
        expect(errors).toEqual([]);
    });

// ── 127-PYD-11: the leave window, one row under the route row ──

const LEAVE_ROW = '.today-detail li[data-leave]';
const RED = 'Red on the route that no tide clears: see it on the chart.';
const CREDIT = 'Tide from WorldTides (Fixture Gauge); check the official tide table.';
/** Her day trip in routed-tide: the window, there and back, approx, and the pin that dries. */
const DAY_TRIP = new RegExp(
    `^Leave \\d\\d:\\d\\d(?:–\\d\\d:\\d\\d)?(?: or \\d\\d:\\d\\d(?:–\\d\\d:\\d\\d)?)? \\(tide approx\\) to carry the tide over the shallow bit \\d+\\.\\d NM out, there and back; your (\\d\\d:\\d\\d) (works|is too early for it|is too late for it)\\. ${RED.replace(/\./g, '\\.')}$`,
);
/** Overnight, the longest row: two openings, approx, the red sentence and the morning's tide. */
const LONGEST = new RegExp(
    `^Leave \\d\\d:\\d\\d(–\\d\\d:\\d\\d)? or \\d\\d:\\d\\d(–\\d\\d:\\d\\d)? \\(tide approx\\) to carry the tide over the shallow bit \\d+\\.\\d NM out; your (\\d\\d:\\d\\d) (works|is too early for it|is too late for it)\\. ${RED.replace(/\./g, '\\.')} Home tomorrow: check its tide in the morning\\.$`,
);
const ROUTED_DRIES =
    /^Routed on your charts · 16\.5 NM each way · 0\.3 NM shallow · the pin dries · Routed in 6\.4 s · router 4\.1 s$/;

/** Routes the open stop in a tide mode and waits for its leave row's words. */
async function routeForLeave(page: Page, words: RegExp) {
    const detail = await routeIt(page);
    await expect(detail.locator('li[data-route]')).toHaveText(ROUTED_DRIES, { timeout: 10_000 });
    await expect(page.locator(LEAVE_ROW)).toHaveText(words, { timeout: 10_000 });
    return detail;
}

/** Overnight on screen 1, so her morning has leave chips to choose from (and the longest row). */
async function stayOvernight(page: Page) {
    await page
        .getByRole('dialog', { name: 'Plan Your Day', exact: true })
        .getByRole('combobox', { name: 'Stay' })
        .selectOption('overnight');
}

for (const size of [AS_DRAWN.se2, AS_DRAWN.mid, AS_DRAWN.shane])
    test(`the leave row with the route row and its timing fits without a scroll at ${size.name}`, async ({ page }) => {
        const errors = await open(page, size, `&mode=routed-tide&owner=1${size.query}`);
        await openStop(page);
        const detail = await routeForLeave(page, DAY_TRIP);
        // Under the route row; the marina line gone (the route says when the tide allows the way out).
        expect(
            await page.evaluate(
                (sel) => document.querySelector('.today-detail li[data-route]')?.nextElementSibling?.matches(sel),
                LEAVE_ROW,
            ),
        ).toBe(true);
        await expect(detail.getByText(/^Leaving a marina/)).toHaveCount(0);
        await expect(detail.getByText(TIMING, { exact: true })).toBeVisible();
        await expect(detail.locator('.today-footnote')).toContainText(CREDIT);
        await expect(page.locator(LEAVE_ROW)).toBeInViewport({ ratio: 1 });
        expect(await layoutIssues(page, false)).toEqual([]);
        // Where the closing sentence alone stood in the way it folds under the first, a tap away; never with room.
        const row = page.locator(LEAVE_ROW);
        const folded = await row.locator('details').count();
        if (size !== AS_DRAWN.se2) expect(folded).toBe(0);
        if (folded) {
            expect(await row.innerText()).not.toContain('Red on the route');
            await row.locator('summary').click();
            await expect(row.locator('details')).toHaveAttribute('open', '');
        }
        expect(await row.innerText()).toContain(RED);
        expect(errors).toEqual([]);
    });

for (const size of [AS_DRAWN.se2, AS_DRAWN.mid])
    test(`overnight, the longest leave row (two openings, approx, red) fits without a scroll at ${size.name}`, async ({
        page,
    }) => {
        const errors = await open(page, size, `&mode=routed-tide&owner=1${size.query}`);
        await stayOvernight(page);
        const detail = await openStop(page);
        await routeForLeave(page, LONGEST);
        // A chip re-says only its last clause, at once.
        const before = (await page.locator(LEAVE_ROW).textContent())!;
        const chip = detail.getByRole('group', { name: 'Leave at' }).locator('button[aria-pressed="false"]').first();
        const label = (await chip.textContent())!.slice(0, 5);
        await chip.click();
        await expect(page.locator(LEAVE_ROW)).toContainText(`; your ${label} `);
        const after = (await page.locator(LEAVE_ROW).textContent())!;
        expect(after.split('; your ')[0]).toBe(before.split('; your ')[0]);
        expect(await layoutIssues(page, false)).toEqual([]);
        expect(errors).toEqual([]);
    });

// Review 2026-10-13: the fold was decided only when the words changed, so a page opened with room and then given
// less (turned to portrait, a smaller split) kept scrolling. It is measured again whenever the screen changes.
test('the screen growing shorter folds the closing sentences when that makes it fit, and opens them with room again', async ({
    page,
}) => {
    // About 34 resizes of 4 px: Linux WebKit in CI took 24.5 s (release run 38361371829)
    // and ran past the 30 s limit in 38366466523; 6 s in Chromium, under 2 s for the loop on a Mac.
    test.slow();
    const size = AS_DRAWN.mid;
    const errors = await open(page, size, `&mode=routed-tide&owner=1${size.query}`);
    await stayOvernight(page);
    await openStop(page);
    await routeForLeave(page, LONGEST);
    const row = page.locator(LEAVE_ROW);
    await expect(row.locator('details')).toHaveCount(0);
    const settle = () =>
        page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    // Less room, 4 px at a time, with no tap: the first height the closing sentences no longer fit, they fold.
    let height = size.height;
    while (!(await row.locator('details').count()) && height > 450) {
        height -= 4;
        await page.setViewportSize({ width: size.width, height });
        await settle();
    }
    await expect(row.locator('details')).toHaveCount(1);
    expect(height).toBeLessThan(size.height);
    expect(await row.innerText()).not.toContain('Red on the route');
    await expect(row).toHaveText(LONGEST);
    expect(await layoutIssues(page, false)).toEqual([]);
    // Room again: whole.
    await page.setViewportSize({ width: size.width, height: size.height });
    await expect(row.locator('details')).toHaveCount(0);
    expect(await row.innerText()).toContain(RED);
    expect(errors).toEqual([]);
});

test('at 320 x 568 as drawn the routed stop may scroll inside its card, the route and leave rows whole once in view', async ({
    page,
}) => {
    const errors = await open(page, AS_DRAWN.se, `&mode=routed-tide&owner=1${AS_DRAWN.se.query}`);
    await openStop(page);
    await routeForLeave(page, DAY_TRIP);
    expect(await layoutIssues(page, true)).toEqual([]);
    for (const sel of ['.today-detail li[data-route]', LEAVE_ROW]) {
        await page.locator(sel).scrollIntoViewIfNeeded();
        await expect(page.locator(sel)).toBeInViewport({ ratio: 1 });
    }
    expect(errors).toEqual([]);
});

for (const size of OTHER)
    test(`the leave row clips nothing at ${size.name}`, async ({ page }) => {
        const errors = await open(page, size, `&mode=routed-tide&owner=1${size.query}`);
        await stayOvernight(page);
        await openStop(page);
        await routeForLeave(page, LONGEST);
        await page.locator(LEAVE_ROW).scrollIntoViewIfNeeded();
        await expect(page.locator(LEAVE_ROW)).toBeInViewport({ ratio: 1 });
        expect(await layoutIssues(page, true)).toEqual([]);
        expect(errors).toEqual([]);
    });

test('no tide: "Tide not known" with what it needs, and no time in the row', async ({ page }) => {
    const errors = await open(page, AS_DRAWN.se2, `&mode=routed-notide&owner=1${AS_DRAWN.se2.query}`);
    const detail = await openStop(page);
    await routeForLeave(
        page,
        new RegExp(
            `^Tide not known for the shallow bit \\d+\\.\\d NM out \\(it needs 1\\.0 m of tide\\): check the tide table before you go\\. ${RED.replace(/\./g, '\\.')}$`,
        ),
    );
    expect(await page.locator(LEAVE_ROW).textContent()).not.toMatch(/\d\d:\d\d/);
    await expect(detail.locator('.today-footnote')).not.toContainText('WorldTides');
    expect(await layoutIssues(page, false)).toEqual([]);
    expect(errors).toEqual([]);
});

test("Nouméa: the leave window's times are on the place's clock, not the phone's (London here)", async ({ page }) => {
    const errors = await open(page, AS_DRAWN.mid, `&mode=routed-tide&owner=1&place=noumea${AS_DRAWN.mid.query}`);
    const detail = await openStop(page);
    await routeForLeave(page, DAY_TRIP);
    // Her chosen leave in the row is the stop page's own big "LEAVE HH:MM" (132-PYD-8), on Nouméa's clock.
    const leaveAt = (await detail
        .getByRole('list', { name: 'Times' })
        .locator('.today-times-at')
        .first()
        .textContent())!;
    const said = (await page.locator(LEAVE_ROW).textContent())!.match(DAY_TRIP)!;
    expect(said[1]).toBe(leaveAt);
    // Nouméa's morning (UTC+11), never London's evening before.
    const from = (await page.locator(LEAVE_ROW).textContent())!.slice(6, 11);
    expect(from >= '05:00' && from <= '20:00').toBe(true);
    expect(errors).toEqual([]);
});

test('a tester sees no leave row: nothing is asked of the tide', async ({ page }) => {
    const errors = await open(page, AS_DRAWN.mid, `&mode=routed-tide${AS_DRAWN.mid.query}`);
    const detail = await openStop(page);
    await expect(detail.locator('li[data-leave]')).toHaveCount(0);
    expect(await page.locator('body').textContent()).not.toMatch(/carry the tide|Tide not known/);
    expect(errors).toEqual([]);
});
