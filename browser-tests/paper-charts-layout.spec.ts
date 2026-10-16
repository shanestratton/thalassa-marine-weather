import { expect, test } from '@playwright/test';
for (const width of [300, 375])
    test(`official chart controls fit ${width}px, gate NOAA and retain safety floor`, async ({ page }) => {
        await page.setViewportSize({ width, height: 667 });
        let tiles = 0;
        await page.route('**/*', (route) => {
            const u = new URL(route.request().url());
            return ['127.0.0.1', 'localhost'].includes(u.hostname) || u.protocol === 'blob:'
                ? route.continue()
                : route.abort();
        });
        await page.goto('/e2e/fixtures/paper-charts.html');
        const encoded = await page.evaluate(() => {
            const c = document.createElement('canvas');
            c.width = 256;
            c.height = 256;
            const g = c.getContext('2d')!;
            g.fillStyle = '#80c8df';
            g.fillRect(0, 0, 256, 256);
            return c.toDataURL('image/png').split(',')[1];
        });
        await page.route('**/api/noaa-chart?**', (route) => {
            tiles++;
            return route.fulfill({ contentType: 'image/png', body: Buffer.from(encoded, 'base64') });
        });
        const mapState = () =>
            page.evaluate(() => {
                const m = (
                    window as unknown as {
                        __paperMap: {
                            loaded: () => boolean;
                            getSource: (id: string) => unknown;
                            getLayer: (id: string) => unknown;
                            getLayoutProperty: (id: string, p: string) => unknown;
                            getCanvas: () => HTMLCanvasElement;
                        };
                    }
                ).__paperMap;
                return {
                    ready: !!m?.loaded(),
                    source: !!m?.getSource('chart-catalog-noaa-ncds'),
                    base: m?.getLayoutProperty('base-land', 'visibility') ?? 'visible',
                    danger: m?.getLayer('enc-vec-boyisd-symbol')
                        ? (m.getLayoutProperty('enc-vec-boyisd-symbol', 'visibility') ?? 'visible')
                        : 'missing',
                };
            });
        await expect.poll(async () => (await mapState()).ready).toBe(true);
        const trigger = page.getByRole('button', { name: 'Map base: Relief' });
        await trigger.click();
        await page.getByRole('menuitem', { name: 'Charts & detail' }).click();
        expect(tiles).toBe(0);
        await expect(page.getByRole('button', { name: /NOAA Charts · Off/ })).toBeVisible();
        await expect(page.getByRole('button', { name: /LINZ Charts/ })).toHaveCount(0);
        await page.getByRole('button', { name: /NOAA Charts · Off/ }).click();
        const agreement = page.getByRole('dialog', { name: 'NOAA chart agreement' });
        await expect(agreement).toBeVisible();
        expect(tiles).toBe(0);
        await agreement.getByRole('checkbox').check();
        await agreement.getByRole('button', { name: 'Accept NOAA agreement' }).click();
        await expect.poll(() => tiles).toBeGreaterThan(0);
        await expect.poll(async () => (await mapState()).source).toBe(true);
        const probe = (centre = false) =>
            page.evaluate(
                (centre) =>
                    (
                        window as unknown as {
                            __paperProbe: (centre: boolean) => Promise<{ pixel: number[]; loaded: boolean }>;
                        }
                    ).__paperProbe(centre),
                centre,
            );
        await expect
            .poll(async () => {
                const { pixel, loaded } = await probe();
                return loaded && pixel[2] > 170 && pixel[0] < 150;
            })
            .toBe(true);
        await page.getByRole('slider', { name: 'NOAA Charts opacity' }).fill('0.45');
        await page.getByRole('button', { name: 'Base', exact: true }).click();
        expect((await mapState()).danger).toBe('visible');
        const sheet = page.getByRole('dialog', { name: 'Charts & detail' });
        await expect(sheet).toBeVisible();
        expect(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await expect(sheet.getByRole('link', { name: /NOAA Office of Coast Survey/ })).toBeAttached();
        await sheet.getByRole('button', { name: 'Close', exact: true }).focus();
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Satellite off' }).click();
        await expect.poll(async () => (await mapState()).source).toBe(false);
        await page.getByRole('button', { name: 'Satellite on' }).click();
        await expect.poll(async () => (await mapState()).source).toBe(true);
        await page.getByRole('button', { name: 'Map base: Relief' }).click();
        await page.getByRole('menuitemradio', { name: /ENC only/ }).click();
        await expect.poll(async () => (await mapState()).base).toBe('none');
        expect((await mapState()).danger).toBe('visible');
        await expect
            .poll(async () => {
                const { pixel } = await probe(true);
                return pixel[0] > 200 && pixel[1] < 80 && pixel[2] < 80;
            })
            .toBe(true);
        await page.getByRole('button', { name: 'Satellite off' }).click();
        await expect.poll(async () => (await mapState()).source).toBe(false);
        const before = tiles;
        await page.getByRole('button', { name: 'NZ camera' }).click();
        await page.getByRole('button', { name: 'Map base: ENC only' }).click();
        await page.getByRole('menuitem', { name: 'Charts & detail' }).click();
        await expect(page.getByRole('button', { name: /LINZ Charts · Off/ })).toBeVisible();
        await expect(page.getByRole('button', { name: /NOAA Charts/ })).toHaveCount(0);
        expect(tiles).toBe(before);
    });
