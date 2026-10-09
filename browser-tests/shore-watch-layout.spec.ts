import { expect, test, type Locator, type Page } from '@playwright/test';

async function openFixture(page: Page, width: number, height: number, query = '') {
    // The configured server's own origin (4199 in the layout config).
    const origin = new URL(test.info().project.use.baseURL ?? 'http://127.0.0.1:4199').origin;
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return url.origin === origin &&
            ['GET', 'HEAD'].includes(route.request().method()) &&
            !url.pathname.startsWith('/api/')
            ? route.continue()
            : route.abort();
    });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.setViewportSize({ width, height });
    await page.goto(`/e2e/fixtures/shore-watch.html${query}`);
    await expect(page.getByRole('region', { name: 'Vessel anchor readings' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
}

async function assertNoHorizontalOverflow(page: Page) {
    expect(
        await page.evaluate(() => {
            const errors: string[] = [];
            for (const element of [
                document.documentElement,
                document.body,
                document.querySelector('[data-testid="shore-watch-page"]')!,
                document.querySelector('[data-testid="shore-readings-scroll"]')!,
                ...document.querySelectorAll('[aria-label="Vessel anchor readings"] *'),
            ]) {
                if (element.scrollWidth > element.clientWidth + 1)
                    errors.push(`${element.tagName}: ${element.scrollWidth} > ${element.clientWidth}`);
            }
            if (window.scrollY !== 0) errors.push('Document scrolled instead of the readings region');
            return errors;
        }),
    ).toEqual([]);
}

async function assertInsideReadings(control: Locator) {
    expect(
        await control.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const scroll = document.querySelector('[data-testid="shore-readings-scroll"]')!.getBoundingClientRect();
            const nav = document.querySelector('nav')!.getBoundingClientRect();
            return (
                box.top >= scroll.top - 1 &&
                box.bottom <= Math.min(scroll.bottom, nav.top) + 1 &&
                box.left >= scroll.left - 1 &&
                box.right <= scroll.right + 1
            );
        }),
    ).toBe(true);
}

/**
 * Taller than the readings region (a landscape phone, wide fonts), a control is
 * reachable when the region scrolls each of its edges into view in turn.
 */
async function assertScrollsWhole(control: Locator) {
    expect(
        await control.evaluate((element) => {
            const scroll = document.querySelector('[data-testid="shore-readings-scroll"]')!;
            const nav = document.querySelector('nav')!.getBoundingClientRect();
            const view = () => {
                const region = scroll.getBoundingClientRect();
                return {
                    top: region.top,
                    bottom: Math.min(region.bottom, nav.top),
                    left: region.left,
                    right: region.right,
                };
            };
            const box = () => element.getBoundingClientRect();
            const errors: string[] = [];
            if (box().left < view().left - 1 || box().right > view().right + 1) errors.push('wider than the region');
            // Each edge, scrolled to, is on screen in the region.
            scroll.scrollTop += box().top - view().top;
            if (box().top < view().top - 1 || box().top >= view().bottom)
                errors.push(`top edge out of reach: ${box().top} vs ${view().top}..${view().bottom}`);
            scroll.scrollTop += box().bottom - view().bottom;
            if (box().bottom > view().bottom + 1 || box().bottom <= view().top)
                errors.push(`bottom edge out of reach: ${box().bottom} vs ${view().top}..${view().bottom}`);
            if (window.scrollY !== 0) errors.push('Document scrolled instead of the readings region');
            return errors;
        }),
    ).toEqual([]);
}

/**
 * The distance is beside the radar canvas, never over it: on a small radar it
 * sat on the circle's north-west arc, over the boat when she lay there
 * (review 126-03a, 844x430 and 320x568 in wide fonts).
 */
async function assertDistanceBesideRadar(page: Page) {
    const canvas = (await page.getByRole('img', { name: /Shore Watch radar/ }).boundingBox())!;
    const distance = (await page.getByTestId('shore-radar-distance').boundingBox())!;
    expect(distance.x + distance.width, 'the distance ends where the canvas begins').toBeLessThanOrEqual(canvas.x + 1);
}

/** The radar is drawn, at least 128 px square, inside the readings, with the distance beside it. */
async function assertRadar(page: Page) {
    const radar = page.getByRole('img', { name: /Shore Watch radar/ });
    await expect(radar).toBeVisible();
    const box = (await radar.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(128);
    expect(box.height).toBeGreaterThanOrEqual(128);
    await assertInsideReadings(radar);
    await assertInsideReadings(page.getByTestId('shore-radar-distance'));
    await assertDistanceBesideRadar(page);
}

for (const size of [
    { width: 390, height: 844 },
    { width: 430, height: 932 },
    { width: 375, height: 667 },
]) {
    test(`Healthy Shore Watch fits ${size.width}x${size.height} above navigation`, async ({ page }, info) => {
        await openFixture(page, size.width, size.height);
        const scroll = page.getByTestId('shore-readings-scroll');
        expect(await scroll.evaluate((element) => element.scrollTop)).toBe(0);
        expect(await scroll.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
        await assertNoHorizontalOverflow(page);
        await assertInsideReadings(page.getByRole('region', { name: 'Vessel anchor readings' }));
        for (const label of ['Swing Radius', 'Rode', 'Depth', 'Last Update']) {
            await expect(page.getByText(label, { exact: true })).toBeVisible();
            await assertInsideReadings(page.getByText(label, { exact: true }));
        }
        for (const value of ['50 m', '45 m', '4.3 m'])
            await assertInsideReadings(page.getByText(value, { exact: true }));
        // 126-03a: the real radar, not a ring with a number in it.
        await assertRadar(page);
        await expect(page.getByRole('status')).toHaveText('Holding');
        await expect(page.getByRole('button', { name: 'Leave Shore Watch' })).toBeInViewport();
        if (size.width === 430) {
            const path = info.outputPath('shore-watch-430x932.png');
            await page.screenshot({ path, animations: 'disabled' });
            await info.attach('shore-watch-430x932', { path, contentType: 'image/png' });
        }
    });
}

for (const size of [
    { label: 'short phone', width: 375, height: 667, query: '?notificationWarning=true' },
    { label: 'large text', width: 390, height: 844, query: '?notificationWarning=true&largeText=true' },
]) {
    test(`Shore Watch notification warning stays actionable with ${size.label}`, async ({ page }) => {
        await openFixture(page, size.width, size.height, size.query);
        const retry = page.getByRole('button', { name: 'Retry notifications' });
        await expect(retry).toBeInViewport();
        await retry.click();
        await expect(retry).toBeDisabled();
        await expect(page.getByText('Checking background notifications…')).toBeVisible();
        const lastUpdate = page.getByText('Last Update', { exact: true }).locator('..');
        await lastUpdate.scrollIntoViewIfNeeded();
        await assertInsideReadings(lastUpdate);
        await assertNoHorizontalOverflow(page);
    });
}

for (const scenario of ['stale', 'alarm']) {
    test(`Shore Watch ${scenario} stays readable and controls remain reachable`, async ({ page }) => {
        await openFixture(page, 375, 667, `?scenario=${scenario}`);
        await assertNoHorizontalOverflow(page);
        const status = page.getByRole('status');
        await expect(status).toHaveText(scenario === 'alarm' ? 'Drag Alarm' : 'Last-known data');
        if (scenario === 'stale') {
            await expect(page.getByText(/Vessel offline · showing last-known data/)).toBeInViewport();
            await expect(page.getByText('last-known from anchor')).toBeVisible();
        }
        await status.scrollIntoViewIfNeeded();
        await assertInsideReadings(status);
        const mute = page.getByRole('button', { name: 'Mute alarm on this device only' });
        await mute.scrollIntoViewIfNeeded();
        await assertInsideReadings(mute);
        await mute.click();
        await expect(mute).toBeDisabled();
        await expect(mute).toContainText('Muted on this device only');
        const lastUpdate = page.getByText(scenario === 'stale' ? 'Last-Known Update' : 'Last Update', { exact: true });
        await lastUpdate.locator('..').scrollIntoViewIfNeeded();
        await assertInsideReadings(lastUpdate.locator('..'));
        await assertNoHorizontalOverflow(page);
    });
}

// Shane 2026-09-29: on this phone's own Pi watch, Weigh Anchor ends the
// readings column, beside the header's Leave. The readings keep the region
// (pinned under it, compact landscape had a 40 px sliver of readings), and the
// button scrolls into reach whole, tappable and clear of the tab bar on the
// smallest phone, in landscape and at large text.
for (const size of [
    { label: 'small phone', width: 320, height: 568, query: '?ownPi=true' },
    { label: 'short phone', width: 375, height: 667, query: '?ownPi=true' },
    { label: 'compact landscape', width: 844, height: 430, query: '?ownPi=true' },
    { label: 'large text', width: 390, height: 844, query: '?ownPi=true&largeText=true' },
]) {
    test(`Shore Watch Weigh Anchor stays reachable above navigation on a ${size.label}`, async ({ page }) => {
        // The bar takes no room from the readings: same region, same start.
        const readings = page.getByTestId('shore-readings-scroll');
        await openFixture(page, size.width, size.height, size.query.replace(/ownPi=true&?/, '').replace(/\?$/, ''));
        const without = await readings.evaluate((el) => ({ height: el.clientHeight, top: el.scrollTop }));
        await openFixture(page, size.width, size.height, size.query);
        expect(await readings.evaluate((el) => ({ height: el.clientHeight, top: el.scrollTop }))).toEqual(without);
        await expect(page.getByRole('button', { name: 'Leave Shore Watch' })).toBeInViewport();
        const weigh = page.getByRole('button', { name: '⏏ Weigh Anchor' });
        await expect(weigh).toHaveAccessibleDescription('Stops the Pi’s watch. Leave keeps the Pi watching.');
        const note = page.getByText('Stops the Pi’s watch. Leave keeps the Pi watching.');
        await note.scrollIntoViewIfNeeded();
        await assertInsideReadings(weigh);
        await assertInsideReadings(note);
        expect(await weigh.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
        await assertNoHorizontalOverflow(page);
        await weigh.click();
        await expect(page.getByRole('alert')).toHaveText('Weigh anchor pressed');
    });
}

for (const size of [
    { label: 'compact landscape', width: 844, height: 430, query: '' },
    { label: 'large text', width: 390, height: 844, query: '?largeText=true' },
]) {
    test(`Shore Watch ${size.label} scrolls within its available space`, async ({ page }) => {
        await openFixture(page, size.width, size.height, size.query);
        const scroll = page.getByTestId('shore-readings-scroll');
        const headerBefore = await page.getByRole('heading', { name: 'Shore Watch' }).boundingBox();
        expect(await scroll.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
            await scroll.evaluate((element) => element.clientHeight),
        );
        const lastUpdate = page.getByText('Last Update', { exact: true }).locator('..');
        await lastUpdate.scrollIntoViewIfNeeded();
        await assertInsideReadings(lastUpdate);
        expect(await scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        expect(await page.getByRole('heading', { name: 'Shore Watch' }).boundingBox()).toEqual(headerBefore);
        await scroll.evaluate((element) => element.scrollTo({ top: 0, behavior: 'instant' }));
        await assertInsideReadings(page.getByText('from anchor', { exact: true }));
        await assertNoHorizontalOverflow(page);
    });
}

// 126-03b: the boat's phone checks in with the server, so the crew are told if
// it goes quiet. The shore view says so only while it is true, and the line
// costs the healthy short phone no scroll.
for (const size of [
    { width: 375, height: 667, query: '?quietWatch=1' },
    { width: 320, height: 568, query: '?quietWatch=1&largeText=true' },
]) {
    test(`Shore Watch promises a page when the boat phone goes quiet at ${size.width}x${size.height}${size.query.includes('largeText') ? ' in wide fonts' : ''}`, async ({
        page,
    }) => {
        const promise =
            'Her phone checks in every minute. If it goes quiet you’ll be told, even with this phone locked.';
        await openFixture(page, size.width, size.height);
        await expect(page.getByText(promise)).toHaveCount(0);
        await openFixture(page, size.width, size.height, size.query);
        const line = page.getByText(promise, { exact: true });
        await line.scrollIntoViewIfNeeded();
        await expect(line).toBeVisible();
        await assertInsideReadings(line);
        await assertNoHorizontalOverflow(page);
        if (!size.query.includes('largeText')) {
            // The healthy short phone still fits whole: no scroll inside the readings either.
            const scroll = page.getByTestId('shore-readings-scroll');
            expect(await scroll.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
            await assertRadar(page);
            for (const label of ['Swing Radius', 'Rode', 'Depth', 'Last Update'])
                await assertInsideReadings(page.getByText(label, { exact: true }));
        }
    });
}

// 126-03a: the radar ashore, her trail, the viewer's units, and the boat's
// live depth and wind when the Pi sends them (126-05).

test('Shore Watch with live depth and wind shows six readings on a short phone, scrolling only inside the readings', async ({
    page,
}) => {
    await openFixture(page, 375, 667, '?live=1');
    const metrics = page.locator('[aria-label="Shore Watch metrics"]');
    await expect(metrics.locator('dt')).toHaveCount(6);
    for (const label of ['Swing Radius', 'Rode', 'Depth', 'Last Update', 'Depth below keel', 'Wind']) {
        const cell = page.getByText(label, { exact: true }).locator('..');
        await cell.scrollIntoViewIfNeeded();
        await assertInsideReadings(cell);
    }
    await expect(page.getByText('18 kn · 135°T', { exact: true })).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await expect(page.getByRole('heading', { name: 'Shore Watch' })).toBeInViewport();
});

for (const size of [
    { label: 'small phone', width: 320, height: 568, query: '' },
    { label: 'small phone in wide fonts', width: 320, height: 568, query: '?largeText=true' },
    { label: 'compact landscape', width: 844, height: 430, query: '' },
]) {
    test(`Shore Watch radar and every reading stay reachable on a ${size.label}`, async ({ page }, info) => {
        await openFixture(page, size.width, size.height, size.query);
        const radar = page.getByRole('img', { name: /Shore Watch radar/ });
        await radar.scrollIntoViewIfNeeded();
        const box = (await radar.boundingBox())!;
        expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(128);
        await assertScrollsWhole(radar);
        // In wide fonts on the smallest phone a cell ("Last update / 02:06 PM",
        // two lines each) can be taller than the region: each edge must scroll in.
        for (const label of ['Swing Radius', 'Rode', 'Depth', 'Last Update'])
            await assertScrollsWhole(page.getByText(label, { exact: true }).locator('..'));
        await assertNoHorizontalOverflow(page);
        await page.getByTestId('shore-readings-scroll').evaluate((el) => el.scrollTo({ top: 0, behavior: 'instant' }));
        await assertDistanceBesideRadar(page);
        if (size.width > size.height) {
            // Landscape: the radar sits beside the readings, not above them.
            const radarBox = (await radar.boundingBox())!;
            const grid = (await page.locator('[aria-label="Shore Watch metrics"]').boundingBox())!;
            expect(radarBox.x + radarBox.width).toBeLessThanOrEqual(grid.x + 1);
            expect(radarBox.y).toBeLessThan(grid.y + grid.height);
            expect(grid.y).toBeLessThan(radarBox.y + radarBox.height);
        }
        if (size.query.includes('largeText')) {
            const path = info.outputPath('shore-watch-320x568-large-text.png');
            await page.screenshot({ path, animations: 'disabled' });
            await info.attach('shore-watch-320x568-large-text', { path, contentType: 'image/png' });
        }
    });
}

test("Shore Watch reads in the viewer's own units: feet", async ({ page }) => {
    await openFixture(page, 390, 844, '?units=ft');
    await expect(page.getByText('164 ft', { exact: true })).toBeVisible();
    await expect(page.getByText('148 ft', { exact: true })).toBeVisible();
    await expect(page.getByText('14.1 ft', { exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: /Shore Watch radar/ })).toHaveAccessibleName(/36 ft from the anchor/);
    await expect(page.getByText(/\b\d+ m\b/)).toHaveCount(0);
});

test('Shore Watch draws her trail across the antimeridian on the radar (Taveuni)', async ({ page }) => {
    await openFixture(page, 390, 844, '?anti=1');
    // The fixture's trail is one unbroken stretch, its first half-minute 7 min before the fix.
    const since = await page.evaluate(() =>
        new Date(new Date('2026-09-24T04:06:00Z').getTime() - 14 * 30_000).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
        }),
    );
    await expect(page.getByText(`Trail since ${since}`, { exact: true })).toBeVisible();
    const radar = page.getByRole('img', { name: /Shore Watch radar/ });
    // Two frames, so the draw loop has painted.
    await radar.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))),
    );
    const { onTrail, offTrail } = await radar.evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        const ctx = canvas.getContext('2d')!;
        const ratio = canvas.width / canvas.clientWidth;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        // The shore radar's fitted rose (SwingCircleCanvas radarRose): 35% of the
        // short side, pulled in only where the letters would leave the canvas.
        const short = Math.min(w, h);
        const radius = short / 2 - short * 0.35 >= 40 ? short * 0.35 : Math.min(short * 0.35, short / 2 - 26);
        const scale = radius / 60; // swing radius 60 m in the fixture
        const brightness = (x: number, y: number) => {
            let best = 0;
            const data = ctx.getImageData(Math.round(x * ratio) - 2, Math.round(y * ratio) - 2, 5, 5).data;
            for (let i = 0; i < data.length; i += 4) best = Math.max(best, data[i] + data[i + 1] + data[i + 2]);
            return best;
        };
        const at = (bearing: number) => {
            const rad = (bearing * Math.PI) / 180;
            // The fixture's trail runs 42 m from the anchor, WNW through N to E.
            return [w / 2 + Math.sin(rad) * 42 * scale, h / 2 - Math.cos(rad) * 42 * scale] as const;
        };
        const bearings = [320, 330, 340, 350, 0, 10, 20, 30, 40];
        return {
            onTrail: bearings.map((b) => brightness(...at(b))),
            // The same distance south of the anchor: the same rings, no trail.
            offTrail: bearings.map((b) => brightness(...at(180 + b))),
        };
    });
    const brighter = onTrail.filter((value, i) => value > offTrail[i] + 40).length;
    expect(brighter, `trail ${onTrail} vs none ${offTrail}`).toBeGreaterThanOrEqual(6);
});
