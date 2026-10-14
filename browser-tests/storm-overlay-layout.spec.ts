import { expect, test, type Page } from '@playwright/test';

/**
 * Obs with a storm open, and its clear view (129-13), rendered for real in
 * Chromium and WebKit (e2e/fixtures/storm-overlay.tsx).
 *
 * The storm overlay, from Shane's 14 Oct look at build 129 against the live
 * feed: the threat chip sat on the storm card's header with its "W" on a line
 * of its own; chip, card and "2 / 3 · SIMON" stepper filled the top half of a
 * 390 x 844 screen and ran under MOB; the card said "E · ep202026". Now one
 * card, the chip's words and the stepper inside it, clear of MOB, the layers
 * button and the top row at 320 x 568 in large text, 390 x 844 and the iPad,
 * the basin and the storm's number in words.
 *
 * The clear view: H (and, in Chromium, two fingers held on a real Mapbox map)
 * hides every control but MOB, the credits, the Mapbox wordmark and the
 * scrubber, without moving the chart; one tap brings them back and never
 * reaches the chart. A two-finger TAP is still Mapbox's zoom-out.
 *
 * 129-13b: asked how clearing the screen should work, Shane chose "Two-finger
 * hold (Recommended)" on 14 Oct, not a long press on the scrubber and not
 * both. So the hold clears the screen with a weather layer up and with none,
 * and the scrubber's pill stays, and works, in the clear view without being
 * a switch: a long press on it clears nothing and brings nothing back.
 */

const SIZES = [
    { name: 'phone-320-large-text', width: 320, height: 568, query: '?largeText&fonts=wide' },
    { name: 'phone-390', width: 390, height: 844, query: '?fonts=wide' },
    { name: 'ipad-820', width: 820, height: 1180, query: '?fonts=wide' },
];

// BEFORE / AFTER pictures for the package notes: STORM_CAPTURE_DIR=/some/dir.
const captureDir = process.env.STORM_CAPTURE_DIR;

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

async function openFixture(page: Page, size: { width: number; height: number }, query: string, readyMs = 5_000) {
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
    await page.goto(`/e2e/fixtures/storm-overlay.html${query}`);
    await expect(page.locator('html')).toHaveAttribute('data-storm-fixture', 'ready', { timeout: readyMs });
    await page.evaluate(() => document.fonts.ready);
    return errors;
}

/** The boxes that share the top of the chart, measured once the card has painted. */
function topBoxes(page: Page) {
    return page.evaluate(() => {
        const box = (el: Element | null | undefined): Rect | null => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        };
        const card = document.querySelector('#cyclone-hud-badges > div > div');
        return {
            card: box(card),
            stepper: box(document.querySelector('[data-storm-switcher]')),
            mob: box(document.querySelector('.radial-helm-mob')),
            layers: box(document.querySelector('.radial-helm-menu button:not(.radial-helm-mob)')),
            zoom: box(document.querySelector('[aria-label^="Zoom "]')),
            base: box(document.querySelector('[aria-label^="Map base: "]')),
            chip: box(document.querySelector('[data-threat-chip]')),
            meta: document.querySelector('[data-storm-meta]')?.textContent ?? '',
            away: document.querySelector('[data-storm-distance]')?.textContent ?? '',
            mobHit: (() => {
                const mob = document.querySelector('.radial-helm-mob');
                if (!mob) return false;
                const r = mob.getBoundingClientRect();
                const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return !!hit && (hit === mob || mob.contains(hit));
            })(),
            vw: innerWidth,
            vh: innerHeight,
        };
    });
}

const apart = (a: Rect, b: Rect) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;

/** An element's computed visibility, or 'missing'. */
const visibilityOf = (page: Page, selector: string) =>
    page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).visibility : 'missing';
    }, selector);

type Cdp = Awaited<ReturnType<ReturnType<Page['context']>['newCDPSession']>>;
/**
 * One gesture's touches through one DevTools session (it keeps the fingers
 * down between calls), each carrying its own time from the gesture's start,
 * so a busy runner cannot stretch a 90 ms tap past Mapbox's 500 ms (it reads
 * the events' timeStamps). The waits are real too, for the clear view's own timer.
 */
async function touches(
    page: Page,
    cdp: Cdp,
    steps: { type: string; points: { x: number; y: number }[]; waitMs: number }[],
) {
    let clock = Date.now() / 1000;
    for (const step of steps) {
        await cdp.send('Input.dispatchTouchEvent', {
            type: step.type as 'touchStart',
            touchPoints: step.points.map((p, id) => ({ x: p.x, y: p.y, id })),
            timestamp: clock,
        });
        clock += step.waitMs / 1000;
        if (step.waitMs) await page.waitForTimeout(step.waitMs);
    }
}

/** Two fingers, 110 px apart mid-chart at 390 x 844, clear of every control. */
const FINGER_A = { x: 140, y: 520 };
const FINGER_B = { x: 250, y: 520 };
/** A quick two-finger tap: Mapbox's zoom-out. */
const TWO_FINGER_TAP = [
    { type: 'touchStart', points: [FINGER_A, FINGER_B], waitMs: 90 },
    { type: 'touchEnd', points: [], waitMs: 0 },
];
/** Two fingers held 700 ms, creeping 5 px as on a moving boat: the clear view's way in and out. */
const creep = (d: number) => [
    { x: FINGER_A.x + d, y: FINGER_A.y + d },
    { x: FINGER_B.x + d, y: FINGER_B.y + d },
];
const TWO_FINGER_HOLD = [
    { type: 'touchStart', points: [FINGER_A, FINGER_B], waitMs: 150 },
    { type: 'touchMove', points: creep(2), waitMs: 150 },
    { type: 'touchMove', points: creep(4), waitMs: 150 },
    { type: 'touchMove', points: creep(5), waitMs: 250 },
    { type: 'touchEnd', points: [], waitMs: 500 },
];

for (const size of SIZES) {
    test(`one storm card, clear of MOB, the rail and the top row, with the basin in words, at ${size.name}`, async ({
        page,
    }) => {
        test.slow();
        const errors = await openFixture(page, size, size.query);
        // Painted by the card's own builder, so poll until it has laid out.
        await expect.poll(async () => (await topBoxes(page)).card?.height ?? 0).toBeGreaterThan(100);
        const b = await topBoxes(page);
        expect(b.card && b.mob && b.layers && b.zoom && b.stepper).toBeTruthy();
        // The chip stood aside: its storm's distance is on the card.
        expect(b.chip).toBeNull();
        expect(b.away).toMatch(/^\d+\u00a0NM\u00a0W · Cat 1 · 80 kt winds$/);
        // One card: the stepper inside it.
        expect(b.stepper!.top).toBeGreaterThanOrEqual(b.card!.top);
        expect(b.stepper!.bottom).toBeLessThanOrEqual(b.card!.bottom + 0.5);
        expect(b.stepper!.left).toBeGreaterThanOrEqual(b.card!.left - 0.5);
        expect(b.stepper!.right).toBeLessThanOrEqual(b.card!.right + 0.5);
        // Nothing overlaps: the card, MOB, the layers button, the zoom readout, the base pill.
        for (const [name, other] of Object.entries({ mob: b.mob!, layers: b.layers!, zoom: b.zoom!, base: b.base })) {
            if (other) expect(apart(b.card!, other), `card overlaps ${name}`).toBe(true);
        }
        expect(b.mob!.left - b.card!.right).toBeGreaterThanOrEqual(7.5);
        // MOB is uncovered: one tap away.
        expect(b.mobHit).toBe(true);
        // Inside the screen.
        expect(b.card!.left).toBeGreaterThanOrEqual(0);
        expect(b.card!.right).toBeLessThanOrEqual(b.vw);
        // "E · ep312026" no more: the basin and the storm's number in words.
        expect(b.meta).toMatch(/^East Pacific · storm 31 · 20\.1°N 107\.6°W$/);
        expect(b.meta).not.toMatch(/\b[a-z]{2}\d{6}\b/i);
        expect(errors).toEqual([]);
    });

    test(`a nearer storm's chip sits over the card, never on it, its distance on one line, at ${size.name}`, async ({
        page,
    }) => {
        test.slow();
        const errors = await openFixture(page, size, `${size.query}&nearer=1`);
        await expect.poll(async () => (await topBoxes(page)).chip?.height ?? 0).toBeGreaterThan(20);
        // The card moves under the chip once the chip has measured itself: poll.
        await expect
            .poll(async () => {
                const b = await topBoxes(page);
                return b.chip && b.card ? b.card.top - b.chip.bottom : -1;
            })
            .toBeGreaterThanOrEqual(7.5);
        const b = await topBoxes(page);
        expect(apart(b.chip!, b.card!)).toBe(true);
        expect(b.chip!.left).toBeGreaterThanOrEqual(0);
        expect(b.chip!.right).toBeLessThanOrEqual(b.vw);
        // "138 NM W" stays on one line: never a "W" on a line of its own.
        const lines = await page.evaluate(() => {
            const label = document.querySelector('[data-threat-chip] div > span:first-child');
            const text = label?.firstChild;
            if (!text || !text.textContent) return null;
            const at = text.textContent.search(/\d+\u00a0NM\u00a0[NESW]{1,2}$/);
            const range = document.createRange();
            range.setStart(text, at);
            range.setEnd(text, text.textContent.length);
            return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
        });
        expect(lines).toBe(1);
        if (size.width >= 390) {
            // Wide enough: the whole label on one line.
            const height = await page.evaluate(
                () =>
                    document.querySelector('[data-threat-chip] div > span:first-child')!.getBoundingClientRect().height,
            );
            expect(height).toBeLessThan(26);
        }
        expect(errors).toEqual([]);
    });

    test(`the clear view keeps MOB, the credits and the scrubber, moves nothing, and a tap brings it all back, at ${size.name}`, async ({
        page,
    }) => {
        test.slow();
        const errors = await openFixture(page, size, size.query);
        await expect.poll(async () => (await topBoxes(page)).card?.height ?? 0).toBeGreaterThan(100);
        const chartBefore = await page.getByTestId('chart').boundingBox();
        const visibility = () =>
            page.evaluate(() => {
                const v = (sel: string) => {
                    const el = document.querySelector(sel);
                    return el ? getComputedStyle(el).visibility : 'missing';
                };
                return {
                    card: v('#cyclone-hud-badges'),
                    zoom: v('[aria-label^="Zoom "]'),
                    layers: v('.radial-helm-menu button:not(.radial-helm-mob)'),
                    scale: v('[data-testid="scale"]'),
                    tabBar: v('nav[aria-label="Main"]'),
                    statusCorner: v('[data-testid="status-corner"]'),
                    mob: v('.radial-helm-mob'),
                    stormCredit: v('#cyclone-hud-badges [data-map-credit]'),
                    windCredit: v('[data-testid="wind-credit"]'),
                    wordmark: v('[data-testid="mapbox-wordmark"]'),
                    attribution: v('[data-testid="attribution"]'),
                    pill: v('[data-testid="weather-status-pill"]'),
                };
            });
        await page.locator('body').press('h');
        await expect(page.locator('html')).toHaveAttribute('data-clear-view', 'on');
        // The 150 ms fade, then hidden: poll.
        await expect.poll(visibility).toEqual({
            card: 'hidden',
            zoom: 'hidden',
            layers: 'hidden',
            scale: 'hidden',
            tabBar: 'hidden',
            statusCorner: 'hidden',
            mob: 'visible',
            stormCredit: 'visible',
            windCredit: 'visible',
            wordmark: 'visible',
            attribution: 'visible',
            pill: 'visible',
        });
        // MOB still takes its tap; the chart did not move or resize.
        expect((await topBoxes(page)).mobHit).toBe(true);
        expect(await page.getByTestId('chart').boundingBox()).toEqual(chartBefore);
        await expect(page.getByTestId('clear-view-hint')).toHaveText('Tap anywhere to bring the controls back');
        // The first-time line covers nothing that stays: MOB, a credit, the scrubber.
        const covered = await page.evaluate(() => {
            const hint = document.querySelector('[data-testid="clear-view-hint"]')!.getBoundingClientRect();
            return [...document.querySelectorAll('[data-clear-view-keep], [data-map-credit]')]
                .filter((el) => !el.matches('[data-testid="clear-view-hint"], .sr-only'))
                .filter((el) => {
                    const r = el.getBoundingClientRect();
                    return (
                        r.width > 0 &&
                        r.left < hint.right &&
                        r.right > hint.left &&
                        r.top < hint.bottom &&
                        r.bottom > hint.top
                    );
                })
                .map((el) => el.textContent?.trim().slice(0, 40));
        });
        expect(covered).toEqual([]);
        await expect(page.getByRole('button', { name: 'Controls hidden. Double tap to show' })).toBeFocused();
        if (captureDir && size.name === 'phone-390' && test.info().project.name === 'chromium')
            await page.screenshot({ path: `${captureDir}/clear-view-390.png`, animations: 'disabled' });
        // One tap on the chart: everything back.
        const chart = await page.getByTestId('chart').boundingBox();
        await page.mouse.click(chart!.x + chart!.width / 2, chart!.y + chart!.height * 0.62);
        await expect(page.locator('html')).toHaveAttribute('data-clear-view', 'off');
        await expect
            .poll(visibility)
            .toMatchObject({ card: 'visible', zoom: 'visible', tabBar: 'visible', statusCorner: 'visible' });
        expect(errors).toEqual([]);
    });
}

test.describe('on a real Mapbox map', () => {
    test.use({ hasTouch: true });

    test('two fingers held clear the screen with a weather layer up and no zoom-out; a two-finger tap is still Mapbox’s zoom-out', async ({
        page,
        browserName,
    }) => {
        test.skip(browserName !== 'chromium', 'touches are sent through Chromium’s DevTools protocol');
        test.slow();
        // A real WebGL map: slow to load in a software renderer on a busy runner.
        const errors = await openFixture(page, { width: 390, height: 844 }, '?map=1', 30_000);
        const zoom = () =>
            page.evaluate(() => (window as unknown as { __stormFixture: { zoom(): number } }).__stormFixture.zoom());
        await expect.poll(zoom).toBe(4);
        // The wind is up: its scrubber's pill is on the chart.
        await expect(page.getByTestId('weather-status-pill')).toBeVisible();
        const cdp = await page.context().newCDPSession(page);
        const A = FINGER_A;
        // A two-finger tap: Mapbox zooms out a level, and the controls stay.
        await touches(page, cdp, TWO_FINGER_TAP);
        await expect.poll(zoom, { timeout: 5_000 }).toBeCloseTo(3, 1);
        await page.waitForTimeout(400);
        await expect(page.locator('html')).toHaveAttribute('data-clear-view', 'off');
        const before = await zoom();
        // A hold, the fingers creeping 5 px as on a moving boat, lifted at 700 ms:
        // the screen clears as they lift, and the zoom stays.
        await touches(page, cdp, TWO_FINGER_HOLD);
        await expect(page.locator('html')).toHaveAttribute('data-clear-view', 'on');
        expect(await zoom()).toBeCloseTo(before, 3);
        // The pill stays over the clear chart.
        await expect.poll(() => visibilityOf(page, '[data-testid="weather-status-pill"]')).toBe('visible');
        // One tap brings the controls back and never reaches the chart (no weather readout).
        const clicks = () =>
            page.evaluate(() =>
                (window as unknown as { __stormFixture: { mapClicks(): number } }).__stormFixture.mapClicks(),
            );
        const counted = await clicks();
        await page.mouse.click(A.x, A.y + 60);
        await expect(page.locator('html')).toHaveAttribute('data-clear-view', 'off');
        await page.waitForTimeout(300);
        expect(await clicks()).toBe(counted);
        // With the controls back, a tap is the chart's again.
        await page.mouse.click(A.x, A.y + 60);
        await expect.poll(clicks).toBe(counted + 1);
        // In the clear view a long press's click still reaches the chart, which drops its pin.
        await page.locator('body').press('h');
        await expect(page.locator('html')).toHaveAttribute('data-clear-view', 'on');
        await page.mouse.move(A.x, A.y + 60);
        await page.mouse.down();
        await page.waitForTimeout(650);
        await page.mouse.up();
        await expect.poll(clicks).toBe(counted + 2);
        await expect(page.locator('html')).toHaveAttribute('data-clear-view', 'on');
        expect(errors).toEqual([]);
    });
});

test('a long press on the scrubber’s pill clears nothing and brings nothing back; in the clear view the pill stays and still opens the timeline', async ({
    page,
}) => {
    test.slow();
    const errors = await openFixture(page, { width: 390, height: 844 }, '?fonts=wide');
    await expect.poll(async () => (await topBoxes(page)).card?.height ?? 0).toBeGreaterThan(100);
    const html = page.locator('html');
    const pill = page.getByTestId('weather-status-pill');
    const reopen = async () => {
        await page.reload();
        await expect(html).toHaveAttribute('data-storm-fixture', 'ready');
        await expect.poll(async () => (await topBoxes(page)).card?.height ?? 0).toBeGreaterThan(100);
    };
    /** Held 900 ms, well past the app's 500 ms long press, then lifted. */
    const longPressPill = async () => {
        const box = (await pill.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(900);
        await page.mouse.up();
        await page.waitForTimeout(300);
    };
    // The controls showing: a long press on the pill is the pill's own, never the clear view.
    await longPressPill();
    if (captureDir && test.info().project.name === 'chromium')
        await page.screenshot({ path: `${captureDir}/pill-long-press-390.png`, animations: 'disabled' });
    await expect(html).toHaveAttribute('data-clear-view', 'off');
    await expect.poll(() => visibilityOf(page, '[aria-label^="Zoom "]')).toBe('visible');

    // In the clear view the pill stays, and a tap on it opens the timeline over the clear
    // chart: the tap is the pill's, not the "tap anywhere" that brings the controls back.
    await reopen();
    await page.locator('body').press('h');
    await expect(html).toHaveAttribute('data-clear-view', 'on');
    await expect.poll(() => visibilityOf(page, '[data-testid="weather-status-pill"]')).toBe('visible');
    await expect.poll(() => visibilityOf(page, '[aria-label^="Zoom "]')).toBe('hidden');
    await pill.click();
    const timeline = page.getByRole('region', { name: 'Weather controls' });
    await expect(timeline).toBeVisible();
    await expect.poll(() => visibilityOf(page, 'section[aria-label="Weather controls"]')).toBe('visible');
    await expect(html).toHaveAttribute('data-clear-view', 'on');

    // A long press on the pill in the clear view brings nothing back either.
    await reopen();
    await page.locator('body').press('h');
    await expect(html).toHaveAttribute('data-clear-view', 'on');
    await longPressPill();
    await expect(html).toHaveAttribute('data-clear-view', 'on');
    expect(errors).toEqual([]);
});

test.describe('two fingers held, the one way in by touch (Shane, 14 Oct)', () => {
    test.use({ hasTouch: true });

    for (const variant of [
        {
            name: 'weather',
            title: 'with a weather layer up; a quick two-finger tap and a long press on the pill do not',
            query: '?fonts=wide',
        },
        {
            name: 'no-weather',
            title: 'with no weather layer; a quick two-finger tap does not',
            query: '?fonts=wide&weather=0',
        },
    ]) {
        test(`clear the screen ${variant.title}`, async ({ page, browserName }) => {
            test.skip(browserName !== 'chromium', 'touches are sent through Chromium’s DevTools protocol');
            test.slow();
            const errors = await openFixture(page, { width: 390, height: 844 }, variant.query);
            await expect.poll(async () => (await topBoxes(page)).card?.height ?? 0).toBeGreaterThan(100);
            const html = page.locator('html');
            const pill = page.getByTestId('weather-status-pill');
            if (variant.name === 'weather') await expect(pill).toBeVisible();
            else await expect(pill).toHaveCount(0);
            const cdp = await page.context().newCDPSession(page);
            // A quick two-finger tap is Mapbox's zoom-out (the real map's test), never the clear view.
            await touches(page, cdp, TWO_FINGER_TAP);
            await page.waitForTimeout(400);
            await expect(html).toHaveAttribute('data-clear-view', 'off');
            // Held: the screen clears as the fingers lift.
            await touches(page, cdp, TWO_FINGER_HOLD);
            await expect(html).toHaveAttribute('data-clear-view', 'on');
            await expect.poll(() => visibilityOf(page, '#cyclone-hud-badges')).toBe('hidden');
            await expect.poll(() => visibilityOf(page, '.radial-helm-mob')).toBe('visible');
            if (variant.name === 'weather')
                await expect.poll(() => visibilityOf(page, '[data-testid="weather-status-pill"]')).toBe('visible');
            if (captureDir)
                await page.screenshot({
                    path: `${captureDir}/clear-view-${variant.name}-390.png`,
                    animations: 'disabled',
                });
            // Held again: the controls come back.
            await touches(page, cdp, TWO_FINGER_HOLD);
            await expect(html).toHaveAttribute('data-clear-view', 'off');
            await expect.poll(() => visibilityOf(page, '#cyclone-hud-badges')).toBe('visible');
            if (variant.name === 'weather') {
                // One finger held on the pill: not a way in.
                const box = (await pill.boundingBox())!;
                const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
                await touches(page, cdp, [
                    { type: 'touchStart', points: [centre], waitMs: 900 },
                    { type: 'touchEnd', points: [], waitMs: 300 },
                ]);
                await expect(html).toHaveAttribute('data-clear-view', 'off');
            }
            expect(errors).toEqual([]);
        });
    }
});

for (const size of SIZES) {
    test(`capture ${size.name}`, async ({ page, browserName }) => {
        test.skip(!captureDir || browserName !== 'chromium', 'pictures only on request, in Chromium');
        await openFixture(page, size, size.query);
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${captureDir}/${size.name}.png`, animations: 'disabled' });
    });
}
