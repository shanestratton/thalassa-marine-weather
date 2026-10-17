import { test, expect, type Page, type Download } from '@playwright/test';
import { readFile } from 'node:fs/promises';
async function local(page: Page, origin?: string) {
    const unexpected: string[] = [];
    await page.route('**/*', (route) => {
        const u = new URL(route.request().url());
        if (origin ? u.origin === origin : ['127.0.0.1', 'localhost'].includes(u.hostname) || u.protocol === 'blob:')
            return route.continue();
        if (u.hostname === 'api.mapbox.com' && u.pathname === '/map-sessions/v1')
            return route.fulfill({ status: 200, body: '' });
        if (u.hostname === 'events.mapbox.com' && u.pathname === '/events/v2')
            return route.fulfill({ status: 204, body: '' });
        unexpected.push(u.origin);
        return route.abort();
    });
    return unexpected;
}
for (const width of [300, 375])
    test(`Charts drawing handoff and foreground reload fit ${width}px130%`, async ({ page, baseURL }, info) => {
        await page.setViewportSize({ width, height: 667 });
        const unexpected = await local(page, new URL(baseURL!).origin),
            errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.routeWebSocket('**/*', (socket) => socket.close());
        await page.goto('/e2e/fixtures/chart-drawing139.html?composed=1');
        await page.addStyleTag({ content: 'html{font-size:130% !important}' });
        await page.getByRole('button', { name: 'Map base: Relief', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Charts & detail', exact: true }).click();
        const paper = page.getByRole('dialog', { name: 'Charts & detail', exact: true });
        const opener = paper.getByRole('button', { name: 'Draw on chart · ruler / annotations', exact: true });
        await opener.scrollIntoViewIfNeeded();
        expect((await opener.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await page.evaluate(() => window.__drawingFixture.competing(true));
        await expect(opener).toBeDisabled();
        await page.evaluate(() => window.__drawingFixture.competing(false));
        await expect(opener).toBeEnabled();
        await opener.click();
        await expect(paper).toHaveCount(0);
        const library = page.getByRole('dialog', { name: 'Draw on chart', exact: true });
        await library.getByLabel('Drawing label').fill('Fictional integrated label');
        await page.screenshot({ path: info.outputPath('charts-drawing-library.png') });
        expect(
            await page.evaluate(() => ({
                width: document.documentElement.scrollWidth,
                height: document.documentElement.scrollHeight,
            })),
        ).toEqual({ width, height: 667 });
        await library.getByRole('button', { name: 'Place label', exact: true }).click();
        await tap(page, 70, 200);
        const tools = page.getByRole('complementary', { name: 'Chart drawing tools' });
        await expect(tools).toContainText('1/256 points');
        await clearsCredits(page);
        await page.screenshot({ path: info.outputPath('charts-drawing-dock.png') });
        await tools.getByRole('button', { name: 'Finish and save', exact: true }).click();
        await expect.poll(async () => (await page.evaluate(() => window.__drawingFixture.probe())).annotations).toBe(1);
        await page.evaluate(() => window.__drawingFixture.foreground(false));
        await expect.poll(async () => (await page.evaluate(() => window.__drawingFixture.probe())).annotations).toBe(0);
        await page.evaluate(() => window.__drawingFixture.foreground(true));
        await expect.poll(async () => (await page.evaluate(() => window.__drawingFixture.probe())).annotations).toBe(1);
        expect(
            await page.evaluate(() => ({
                width: document.documentElement.scrollWidth,
                height: document.documentElement.scrollHeight,
            })),
        ).toEqual({ width, height: 667 });
        expect(unexpected).toEqual([]);
        expect(errors).toEqual([]);
    });
async function open(page: Page) {
    await page.getByRole('button', { name: 'Your drawings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Draw on chart' });
    await expect(dialog).toBeVisible();
    return dialog;
}
async function start(page: Page, kind: 'line' | 'area' | 'label', label: string) {
    const dialog = await open(page);
    await dialog.getByLabel('Drawing label').fill(label);
    await dialog
        .getByRole('button', {
            name: kind === 'line' ? 'Draw line' : kind === 'area' ? 'Draw area' : 'Place label',
            exact: true,
        })
        .click();
    await expect(dialog).toHaveCount(0);
}
const tap = (page: Page, x: number, y: number) =>
    page.getByRole('application', { name: 'Chart drawing surface' }).click({ position: { x, y } });
async function downloadText(download: Download) {
    const path = await download.path();
    if (!path) throw Error('No local test export');
    return readFile(path, 'utf8');
}
async function clearsCredits(page: Page) {
    const tools = await page.getByRole('complementary', { name: 'Chart drawing tools' }).boundingBox();
    expect(tools).not.toBeNull();
    for (const credit of await page.locator('.mapboxgl-ctrl-logo, .mapboxgl-ctrl-attrib-button').all()) {
        if (!(await credit.isVisible())) continue;
        const b = await credit.boundingBox();
        expect(
            tools!.x + tools!.width <= b!.x ||
                b!.x + b!.width <= tools!.x ||
                tools!.y + tools!.height + 4 <= b!.y ||
                b!.y + b!.height + 4 <= tools!.y,
        ).toBe(true);
    }
}
for (const width of [300, 375])
    test(`tap, undo, save, exact export and reload fit ${width}px at 130%`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 780 });
        const unexpected = await local(page);
        await page.goto('/e2e/fixtures/chart-drawing139.html');
        await page.addStyleTag({ content: 'html{font-size:130%}' });
        const before = await page.evaluate(() => ({
            w: document.documentElement.scrollWidth,
            h: document.documentElement.scrollHeight,
        }));
        await start(page, 'line', 'Café <bay> & marks');
        await tap(page, 70, 210);
        await tap(page, width - 70, 260);
        await tap(page, width / 2, 300);
        const tools = page.getByRole('complementary', { name: 'Chart drawing tools' });
        await clearsCredits(page);
        expect(await tools.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await expect(tools).toContainText('3/256 points');
        await tools.getByRole('button', { name: 'Undo point' }).click();
        await expect(tools).toContainText('2/256 points');
        await tools.getByRole('button', { name: 'Minimise drawing tools' }).click();
        await expect(tools.getByRole('button', { name: 'Expand drawing tools' })).toBeVisible();
        await tools.getByRole('button', { name: 'Expand drawing tools' }).click();
        await tools.getByRole('button', { name: 'Finish and save' }).click();
        await expect
            .poll(async () => (await page.evaluate(() => window.__drawingFixture.library())).annotations.length)
            .toBe(1);
        await expect.poll(async () => (await page.evaluate(() => window.__drawingFixture.probe())).loaded).toBe(true);
        const probe = await page.evaluate(() => window.__drawingFixture.probe());
        expect(probe.annotations).toBe(1);
        expect(probe.draft).toBe(0);
        expect(probe.pixel[1]).toBeGreaterThan(60);
        expect(probe.pixel[2]).toBeGreaterThan(80);
        const saved = await page.evaluate(() => window.__drawingFixture.library());
        const dialog = await open(page);
        await expect(dialog).toContainText('Café <bay> & marks');
        expect(await page.locator('bay').count()).toBe(0);
        const download = page.waitForEvent('download');
        await dialog.getByRole('button', { name: 'Export GeoJSON' }).click();
        const body = JSON.parse(await downloadText(await download));
        expect(body.features[0].geometry).toEqual(saved.annotations[0].geometry);
        // This control reflects the durable library. Await the asynchronous
        // filesystem commit before asserting its new checked state.
        const visible = dialog.getByRole('checkbox', { name: 'Show drawing on Obs' });
        await visible.click();
        await expect(visible).not.toBeChecked();
        await expect.poll(async () => (await page.evaluate(() => window.__drawingFixture.probe())).annotations).toBe(0);
        await visible.click();
        await expect(visible).toBeChecked();
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await page.evaluate(() => window.__drawingFixture.resetStyle());
        await expect.poll(async () => (await page.evaluate(() => window.__drawingFixture.probe())).annotations).toBe(1);
        await page.reload();
        await expect(page.getByRole('button', { name: 'Your drawings', exact: true })).toBeEnabled();
        await expect.poll(async () => (await page.evaluate(() => window.__drawingFixture.probe())).annotations).toBe(1);
        expect((await page.evaluate(() => window.__drawingFixture.library())).annotations[0].geometry).toEqual(
            saved.annotations[0].geometry,
        );
        expect(
            await page.evaluate(() => ({
                w: document.documentElement.scrollWidth,
                h: document.documentElement.scrollHeight,
            })),
        ).toEqual(before);
        await page.screenshot({ path: info.outputPath('saved-private-line.png') });
        expect(unexpected).toEqual([]);
    });
test('invalid area refuses, valid area saves and GPX refuses without dropping geometry', async ({ page }, info) => {
    await page.setViewportSize({ width: 375, height: 780 });
    const unexpected = await local(page);
    await page.goto('/e2e/fixtures/chart-drawing139.html');
    await start(page, 'area', 'Fictional area');
    for (const [x, y] of [
        [80, 200],
        [280, 300],
        [80, 300],
        [280, 200],
    ])
        await tap(page, x, y);
    const tools = page.getByRole('complementary', { name: 'Chart drawing tools' });
    await tools.getByRole('button', { name: 'Finish and save' }).click();
    await expect(tools.getByRole('status')).toBeVisible();
    expect((await page.evaluate(() => window.__drawingFixture.library())).annotations).toHaveLength(0);
    await tools.getByRole('button', { name: 'Cancel drawing' }).click();
    await start(page, 'area', 'Fictional area');
    for (const [x, y] of [
        [80, 200],
        [280, 200],
        [180, 300],
    ])
        await tap(page, x, y);
    await tools.getByRole('button', { name: 'Finish and save' }).click();
    await expect
        .poll(async () => (await page.evaluate(() => window.__drawingFixture.library())).annotations.length)
        .toBe(1);
    const saved = await page.evaluate(() => window.__drawingFixture.library()),
        dialog = await open(page);
    await dialog.getByRole('button', { name: 'Export GPX' }).click();
    await expect(dialog.getByRole('status')).toHaveText('GPX cannot preserve an area. Use GeoJSON for this library.');
    expect((await page.evaluate(() => window.__drawingFixture.library())).annotations).toEqual(saved.annotations);
    await page.screenshot({ path: info.outputPath('area-export-refusal.png') });
    await page.evaluate(() => window.__drawingFixture.switchOwner());
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await page.evaluate(() => window.__drawingFixture.probe())).annotations).toBe(0);
    expect(unexpected).toEqual([]);
});
test('boat ruler uses fresh gateway clocks, holds heading unknown and retires stale/foreign evidence', async ({
    page,
}, info) => {
    await page.setViewportSize({ width: 375, height: 780 });
    const unexpected = await local(page);
    await page.goto('/e2e/fixtures/chart-drawing139.html');
    const dialog = await open(page);
    await dialog.getByRole('button', { name: 'Set boat EBL / VRM' }).click();
    await page.evaluate(() => window.__drawingFixture.fix());
    await page.waitForTimeout(1100);
    await page.evaluate(() => window.__drawingFixture.fix());
    await page.waitForTimeout(1100);
    await page.evaluate(() => window.__drawingFixture.fix());
    const tools = page.getByRole('complementary', { name: 'Chart drawing tools' });
    await tools.getByRole('button', { name: 'Use map centre for ruler' }).click();
    // Centre is ownship, so the bounded range refuses; a distinct chart point must be chosen.
    await expect(tools.getByRole('status')).toContainText('0.005 to 50 NM');
    await tap(page, 250, 250);
    await expect(tools).toContainText('degrees true; VRM');
    await expect.poll(async () => (await page.evaluate(() => window.__drawingFixture.probe())).ruler).toBe(2);
    await page.evaluate(() => window.__drawingFixture.fix('gateway', 0, false));
    await expect(tools).toContainText('Relative bearing unknown');
    await page.evaluate(() => window.__drawingFixture.fix('gateway', 14000));
    await expect(tools).toContainText('Boat ruler unknown');
    await clearsCredits(page);
    await expect.poll(async () => (await page.evaluate(() => window.__drawingFixture.probe())).ruler).toBe(0);
    await page.evaluate(() => window.__drawingFixture.fix('cloud'));
    await expect(tools).toContainText('Boat ruler unknown');
    await page.screenshot({ path: info.outputPath('ruler-unknown.png') });
    await page.evaluate(() => window.__drawingFixture.switchVessel());
    await expect(tools).toHaveCount(0);
    expect(unexpected).toEqual([]);
});

test('plain label and keyboard map-centre/Move controls keep exact GPX and bounded layout', async ({ page }, info) => {
    await page.setViewportSize({ width: 300, height: 780 });
    const unexpected = await local(page);
    await page.goto('/e2e/fixtures/chart-drawing139.html');
    await page.addStyleTag({ content: 'html{font-size:130%}' });
    const name = 'Fictional<bay>&' + '船'.repeat(64);
    await start(page, 'label', name);
    const tools = page.getByRole('complementary', { name: 'Chart drawing tools' });
    await tools.getByRole('button', { name: 'Move map', exact: true }).click();
    await tools.getByRole('button', { name: 'East', exact: true }).click();
    await tools.getByRole('button', { name: 'Resume drawing', exact: true }).click();
    await tools.getByRole('button', { name: 'Add map centre', exact: true }).click();
    await clearsCredits(page);
    expect(await tools.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await tools.getByRole('button', { name: 'Finish and save', exact: true }).click();
    await expect
        .poll(async () => (await page.evaluate(() => window.__drawingFixture.library())).annotations.length)
        .toBe(1);
    const saved = (await page.evaluate(() => window.__drawingFixture.library())).annotations[0];
    expect(saved.geometry.type).toBe('Point');
    const dialog = await open(page);
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export GPX' }).click();
    const gpx = await downloadText(await download);
    const decoded = await page.evaluate((text) => {
        const xml = new DOMParser().parseFromString(text, 'application/xml');
        return {
            error: !!xml.querySelector('parsererror'),
            name: xml.querySelector('wpt name')?.textContent,
            lon: Number(xml.querySelector('wpt')?.getAttribute('lon')),
            lat: Number(xml.querySelector('wpt')?.getAttribute('lat')),
        };
    }, gpx);
    expect(decoded.error).toBe(false);
    expect(decoded.name).toBe(name);
    if (saved.geometry.type === 'Point') expect([decoded.lon, decoded.lat]).toEqual(saved.geometry.coordinates);
    await page.screenshot({ path: info.outputPath('long-label-library.png') });
    expect(unexpected).toEqual([]);
});
