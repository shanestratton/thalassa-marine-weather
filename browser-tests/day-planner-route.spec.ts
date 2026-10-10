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
 * with its first three rows in view. The draft modal, when it asks, sits on
 * top of the stop page, centred clear of the tab bar. A tester sees no route
 * row anywhere. Nouméa and Tromsø say why there is no route in global words,
 * never a blank row, never "Pi". The routing cases of 127-PYD-2, 3 and 11 live
 * here, apart from screen 1's spec (127-PYD-common, "the serial file").
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
const ROUTED = /^Routed on your charts · 16\.5 NM each way · 0\.3 NM shallow$/;

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
    await expect(detail.getByRole('list', { name: 'How the day goes' })).toBeVisible();
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

test('at 320 x 568 as drawn the routed stop page may scroll inside its card, its first three rows in view', async ({
    page,
}) => {
    const errors = await open(page, AS_DRAWN.se, `&mode=routed&owner=1${AS_DRAWN.se.query}`);
    await openStop(page);
    const detail = await routeIt(page);
    await expect(detail.locator('li[data-route]')).toHaveText(ROUTED, { timeout: 10_000 });
    expect(await layoutIssues(page, true)).toEqual([]);
    const inView = await page.evaluate(() => {
        const body = document.querySelector('.today-detail .today-body')!.getBoundingClientRect();
        return [...document.querySelectorAll('.today-detail .today-rows li')].slice(0, 3).map((li) => {
            const r = li.getBoundingClientRect();
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

// ── Plot on chart = the routed line (127-PYD-3) ──

/** Auto's chart over Plan Your Day: its footer buttons whole, on screen and clear of the tab bar. */
function dayChartIssues(page: Page) {
    return page.evaluate(() => {
        const issues: string[] = [];
        const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
        for (const name of ['Use on the main chart', 'Whole route', 'Back to Plan Your Day']) {
            const button = [...document.querySelectorAll<HTMLElement>('button')].find(
                (b) => b.textContent?.trim() === name,
            );
            if (!button) {
                issues.push(`no ${name}`);
                continue;
            }
            const r = button.getBoundingClientRect();
            if (r.width < 44 - 0.5 || r.height < 44 - 0.5) issues.push(`${name} is ${r.width}×${r.height}`);
            if (r.top < 0 || r.left < 0 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5)
                issues.push(`${name} is off screen`);
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            if (!hit || !button.contains(hit)) issues.push(`${name} is covered (by ${hit?.tagName ?? 'nothing'})`);
            if (r.bottom > nav.top + 0.5 && hit?.closest('nav')) issues.push(`${name} is under the tab bar`);
        }
        if (document.documentElement.scrollWidth > innerWidth) issues.push('the page scrolls sideways');
        return issues;
    });
}

for (const size of [AS_DRAWN.se, AS_DRAWN.mid, AS_DRAWN.shane])
    test(`routed: Show route on chart opens Auto's chart over Plan Your Day at ${size.name}; Back returns to her stop`, async ({
        page,
    }) => {
        const errors = await open(page, size, `&mode=routed&owner=1${size.query}`);
        await openStop(page);
        const detail = await routeIt(page);
        await expect(detail.locator('li[data-route]')).toHaveText(ROUTED, { timeout: 10_000 });
        const show = detail.getByRole('button', { name: 'Show route on chart' });
        await show.click();
        await expect(page.getByRole('region', { name: 'Plan Your Day route chart' })).toBeAttached({
            timeout: 10_000,
        });
        // Plan Your Day is hidden behind it, not closed: nothing of it shows or takes a tap.
        await expect(page.getByRole('dialog', { name: 'Plan Your Day', exact: true })).toBeHidden();
        await expect(detail).toBeHidden();
        await expect(page.getByRole('button', { name: 'Use on the main chart' })).toBeVisible();
        expect(await dayChartIssues(page)).toEqual([]);
        await page.getByRole('button', { name: 'Back to Plan Your Day' }).click();
        await expect(page.getByRole('region', { name: 'Plan Your Day route chart' })).toHaveCount(0);
        await expect(detail).toBeVisible();
        await expect(detail.locator('li[data-route]')).toHaveText(ROUTED);
        await expect(show).toBeFocused();
        expect(errors).toEqual([]);
    });

test('routed: Use on the main chart plots the routed line, never two points, and closes the planner', async ({
    page,
}) => {
    const errors = await open(page, AS_DRAWN.mid, `&mode=routed&owner=1${AS_DRAWN.mid.query}`);
    await openStop(page);
    const detail = await routeIt(page);
    await expect(detail.locator('li[data-route]')).toHaveText(ROUTED, { timeout: 10_000 });
    await detail.getByRole('button', { name: 'Show route on chart' }).click();
    await page.getByRole('button', { name: 'Use on the main chart' }).click({ timeout: 10_000 });
    await expect(page.getByRole('dialog', { name: 'Plan Your Day', exact: true })).toHaveCount(0);
    const plotted = await page.evaluate(
        () =>
            (
                window as unknown as {
                    __dayPlannerFixture: { plotted: { kind: string; routed?: boolean; points: unknown[] }[] };
                }
            ).__dayPlannerFixture.plotted,
    );
    expect(plotted).toHaveLength(1);
    expect(plotted[0]).toMatchObject({ kind: 'plot-day', routed: true });
    expect(plotted[0].points.length).toBeGreaterThan(2);
    expect(errors).toEqual([]);
});

test('no route (owner) and a tester: Plot by hand sends the two marks and no line', async ({ page }) => {
    const errors = await open(page, AS_DRAWN.se2, `&mode=no-chart&owner=1${AS_DRAWN.se2.query}`);
    await openStop(page);
    const detail = await routeIt(page);
    await expect(detail.locator('li[data-route] [aria-live]')).toHaveText(/^No chart for /, { timeout: 10_000 });
    await detail.getByRole('button', { name: 'Plot by hand', exact: true }).click();
    const plotted = await page.evaluate(
        () =>
            (
                window as unknown as {
                    __dayPlannerFixture: { plotted: { points: unknown[]; frame?: { why: string } }[] };
                }
            ).__dayPlannerFixture.plotted,
    );
    expect(plotted[0].points).toHaveLength(0);
    expect(plotted[0].frame?.why).toMatch(/^No chart for /);
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
