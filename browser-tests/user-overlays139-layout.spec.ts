import { test, expect, type Page } from '@playwright/test';
import { shapeZip } from '../tests/helpers/userOverlayFixture';
const geo = {
    type: 'FeatureCollection',
    features: [
        {
            type: 'Feature',
            properties: { name: 'Fictional annotation café', privateNotes: 'discard me' },
            geometry: {
                type: 'Polygon',
                coordinates: [
                    [
                        [0, 0],
                        [1, 0],
                        [1, 1],
                        [0, 1],
                        [0, 0],
                    ],
                ],
            },
        },
    ],
};
/** Synthetic SDK auth is answered locally; no provider data/auth request leaves this test. */
async function localRequestsOnly(page: Page, unexpected: string[]) {
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (
            ['127.0.0.1', 'localhost'].includes(url.hostname) ||
            (url.protocol === 'blob:' && url.origin === 'http://127.0.0.1:4258')
        )
            return route.continue();
        if (url.hostname === 'api.mapbox.com' && url.pathname === '/map-sessions/v1')
            return route.fulfill({ status: 200, body: '' });
        if (url.hostname === 'events.mapbox.com' && url.pathname === '/events/v2')
            return route.fulfill({ status: 204, body: '' });
        unexpected.push(url.origin);
        return route.abort();
    });
}
for (const width of [300, 375])
    test(`local worker/store/render/entry retirement fits ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 780 });
        const unexpected: string[] = [];
        await localRequestsOnly(page, unexpected);
        await page.goto('/e2e/fixtures/user-overlays139.html');
        await page.getByRole('button', { name: 'Your overlays', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Your overlays' });
        await expect(dialog).toBeVisible();
        await dialog.getByLabel('Choose local overlay').setInputFiles({
            name: 'Fictional.geojson',
            mimeType: 'application/geo+json',
            buffer: Buffer.from(JSON.stringify(geo)),
        });
        await expect(dialog.getByRole('region', { name: 'Overlay preview' })).toBeVisible();
        expect((await page.evaluate(() => window.__overlayProbe())).features).toBe(0);
        await dialog.getByRole('button', { name: 'Import and save overlay' }).click();
        await expect(dialog.getByRole('button', { name: 'Remove Fictional' })).toBeVisible();
        const alerts = dialog.getByRole('checkbox', { name: 'Foreground polygon-entry banner and one quiet chime' });
        await expect(alerts).not.toBeChecked();
        await alerts.click();
        await expect(alerts).toBeChecked();
        await expect(alerts).toBeEnabled();
        expect(
            await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
        ).toBe(false);
        for (const button of await dialog.getByRole('button').all()) {
            const b = await button.boundingBox();
            if (b) expect(b.height).toBeGreaterThanOrEqual(44);
        }
        await page.screenshot({ path: test.info().outputPath('overlay-library.png'), fullPage: true });
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await expect.poll(async () => (await page.evaluate(() => window.__overlayProbe())).features).toBe(1);
        await expect.poll(async () => (await page.evaluate(() => window.__overlayProbe())).loaded).toBe(true);
        const pixel = (await page.evaluate(() => window.__overlayProbe())).pixel;
        expect(pixel[0]).toBeGreaterThan(15);
        expect(pixel[2]).toBeGreaterThan(40);
        await page.evaluate(() => window.__overlayFix(-0.2));
        await page.waitForTimeout(1200);
        await page.evaluate(() => window.__overlayFix(0.5));
        await expect(page.getByText(/Entered Fictional: Fictional annotation/)).toBeVisible();
        await page.screenshot({ path: test.info().outputPath('overlay-entry.png'), fullPage: true });
        await page.getByRole('button', { name: 'Dismiss area notice' }).click();
        await page.evaluate(() => window.__overlayFix(0.6));
        await page.waitForTimeout(1200);
        await expect(page.getByText(/Entered Fictional:/)).toHaveCount(0);
        await page.evaluate(() => window.__overlayRemoveStyle());
        await expect.poll(async () => (await page.evaluate(() => window.__overlayProbe())).features).toBe(1);
        await page.evaluate(() => window.__overlaySwitch());
        await expect.poll(async () => (await page.evaluate(() => window.__overlayProbe())).features).toBe(0);
        await expect(page.getByText(/Entered Fictional:/)).toHaveCount(0);
        expect(unexpected).toEqual([]);
    });

test('actual KML DOM parse and deflated shapefile worker save local point overlays', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 780 });
    const unexpected: string[] = [];
    await localRequestsOnly(page, unexpected);
    await page.goto('/e2e/fixtures/user-overlays139.html');
    await page.getByRole('button', { name: 'Your overlays', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Your overlays' });
    const samples = [
        {
            name: 'KmlReader.kml',
            mimeType: 'application/vnd.google-earth.kml+xml',
            buffer: Buffer.from(
                '<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><name>Fictional KML point</name><Point><coordinates>.5,.5</coordinates></Point></Placemark></kml>',
            ),
        },
        { name: 'ShpReader.zip', mimeType: 'application/zip', buffer: Buffer.from(shapeZip()) },
    ];
    for (const sample of samples) {
        await dialog.getByLabel('Choose local overlay').setInputFiles(sample);
        await expect(dialog.getByRole('region', { name: 'Overlay preview' })).toBeVisible();
        await dialog.getByRole('button', { name: 'Import and save overlay' }).click();
        await expect(
            dialog.getByRole('button', { name: 'Remove ' + sample.name.replace(/\.[^.]+$/, '') }),
        ).toBeVisible();
    }
    for (const checkbox of await dialog
        .getByRole('checkbox', { name: 'Foreground polygon-entry banner and one quiet chime' })
        .all())
        await expect(checkbox).toBeDisabled();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.__overlayProbe())).features).toBe(2);
    expect(unexpected).toEqual([]);
});
