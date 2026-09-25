import { expect, test } from '@playwright/test';

test('separate Sea toggles, colour filter, official popup and style restoration', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/functions/v1/proxy-openmeteo', (route) => {
        const { operation, params } = route.request().postDataJSON();
        const lats = String(params.latitude).split(',').map(Number);
        const lons = String(params.longitude).split(',').map(Number);
        const t = Math.floor(Date.now() / 3_600_000) * 3600;
        const repeated = (n: number) => Array(72).fill(n);
        const data = lats.map((latitude, i) => ({
            latitude,
            longitude: lons[i],
            hourly_units:
                operation === 'forecast'
                    ? { wind_speed_10m: 'kn', wind_gusts_10m: 'kn', wind_direction_10m: '°', weather_code: 'wmo code' }
                    : { wave_height: 'm', wave_direction: '°', wave_period: 's' },
            hourly: {
                time: Array.from({ length: 72 }, (_, h) => t + h * 3600),
                ...(operation === 'forecast'
                    ? {
                          wind_speed_10m: repeated(8),
                          wind_gusts_10m: repeated(12),
                          wind_direction_10m: repeated(135),
                          weather_code: repeated(0),
                      }
                    : { wave_height: repeated(0.2), wave_direction: repeated(135), wave_period: repeated(5) }),
            },
        }));
        return route.fulfill({ json: data.length === 1 ? data[0] : data });
    });
    // Deterministic worldwide supplement; official QPWS snapshot is the actual
    // committed data. No account, GPS, paid API or live-weather request.
    await page.route('**/api/interpreter*', (route) =>
        route.fulfill({
            json: {
                elements: [
                    {
                        type: 'node',
                        id: 90001,
                        lon: 148.927,
                        lat: -20.073,
                        tags: { mooring: 'buoy', colour: 'white', access: 'private', name: 'White test buoy' },
                    },
                    {
                        type: 'node',
                        id: 90002,
                        lon: 148.923,
                        lat: -20.073,
                        tags: { 'seamark:type': 'anchorage', name: 'Test anchorage' },
                    },
                ],
            },
        }),
    );
    await page.goto('/e2e/fixtures/cruising-layers.html');
    await expect(page.getByTestId('status')).toContainText('coverage varies', { timeout: 25_000 });
    await expect
        .poll(() =>
            page.evaluate(() => (window as unknown as { cruisingTest: { count: () => number } }).cruisingTest.count()),
        )
        .toBeGreaterThan(1);
    await page.getByRole('button', { name: 'Open layer menu' }).click();
    await page.getByRole('menuitem', { name: 'Sea layers' }).click();
    await expect(page.getByRole('menuitemcheckbox', { name: 'Moorings, on' })).toBeVisible();
    await expect(page.getByRole('menuitemcheckbox', { name: 'Anchorages, on' })).toBeVisible();
    await page.getByRole('menuitemcheckbox', { name: 'Moorings, on' }).click();
    await expect(page.getByRole('menuitemcheckbox', { name: 'Anchorages, on' })).toBeVisible();
    await page.getByRole('menuitemcheckbox', { name: 'Moorings, off' }).click();
    await page.keyboard.press('Escape');
    await page.locator('summary').click();
    await page.getByLabel('Buoy body colour').selectOption('white');
    await expect
        .poll(() =>
            page.evaluate(() => (window as unknown as { cruisingTest: { count: () => number } }).cruisingTest.count()),
        )
        .toBe(1);
    await page.screenshot({ path: '/tmp/thalassa-mooring-colour-key.png' });
    await page.getByLabel('Buoy body colour').selectOption('all');
    await expect
        .poll(() =>
            page.evaluate(() => (window as unknown as { cruisingTest: { count: () => number } }).cruisingTest.count()),
        )
        .toBeGreaterThan(1);
    await page.locator('summary').click();
    const p = await page.evaluate(() =>
        (window as unknown as { cruisingTest: { point: () => { x: number; y: number } } }).cruisingTest.point(),
    );
    await page.mouse.click(p.x, p.y);
    await expect(page.getByText('MOORING REFERENCE', { exact: true })).toBeVisible();
    await expect(page.locator('.mapboxgl-popup-content')).toContainText('Public — conditions apply');
    await expect(page.locator('.mapboxgl-popup-content')).toContainText('Favourable forecast');
    await expect(page.locator('.mapboxgl-popup-content')).toContainText('Next 12 h');
    const box = await page.locator('.mapboxgl-popup-content').boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await page.context().setOffline(true);
    await expect(page.locator('.mapboxgl-popup-content')).toContainText('Fresh local forecast unavailable.');
    await expect(page.locator('.mapboxgl-popup-content')).not.toContainText('Favourable forecast');
    await page.context().setOffline(false);
    await expect(page.locator('.mapboxgl-popup-content')).toContainText('Favourable forecast');
    await page.screenshot({ path: '/tmp/thalassa-mooring-popup.png' });
    await page.evaluate(() =>
        (window as unknown as { cruisingTest: { resetStyle: () => void } }).cruisingTest.resetStyle(),
    );
    await expect
        .poll(() =>
            page.evaluate(() => (window as unknown as { cruisingTest: { count: () => number } }).cruisingTest.count()),
        )
        .toBeGreaterThan(1);
    expect(errors).toEqual([]);
});
