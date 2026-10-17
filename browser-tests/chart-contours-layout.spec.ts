import { expect, test, type Page } from '@playwright/test';
import type mapboxgl from 'mapbox-gl';

async function readFrame(page: Page) {
    return page.evaluate(async () => {
        const m = (window as unknown as { __chartContoursMap: mapboxgl.Map }).__chartContoursMap;
        await new Promise<void>((resolve) => {
            m.once('render', () => resolve());
            m.triggerRepaint();
        });
        const canvas = m.getCanvas(),
            gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        if (!gl) throw Error('Actual WebGL framebuffer required');
        const pixel = (lon: number, lat: number) => {
            const point = m.project([lon, lat]),
                rgba = new Uint8Array(4);
            const sx = canvas.width / canvas.clientWidth,
                sy = canvas.height / canvas.clientHeight;
            gl.readPixels(
                Math.floor(point.x * sx),
                canvas.height - 1 - Math.floor(point.y * sy),
                1,
                1,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                rgba,
            );
            return Array.from(rgba);
        };
        return {
            background: pixel(180, -26.85),
            enc: [179.4, 179.7, 180, 180.3, 180.6].map((lon) => pixel(lon, -27.01)),
            relief: [179.4, 179.7, 180, 180.3, 180.6].map((lon) => pixel(lon, -27.19)),
            bold: [
                ...new Set(
                    m
                        .queryRenderedFeatures({ layers: ['enc-vec-depcnt-safety'] })
                        .map((f) => `${f.properties?._cellId}:${f.properties?.VALDCO}`),
                ),
            ].sort(),
        };
    });
}
for (const width of [300, 375])
    test(`chart bands ${width}px130%: explicit apply, actual dateline ENC and Relief pixels, bounded menu`, async ({
        page,
    }, testInfo) => {
        await page.setViewportSize({ width, height: 667 });
        const unexpected: string[] = [];
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (['localhost', '127.0.0.1'].includes(url.hostname) || ['data:', 'blob:'].includes(url.protocol))
                return route.continue();
            if (
                (url.hostname === 'api.mapbox.com' && url.pathname === '/map-sessions/v1') ||
                (url.hostname === 'events.mapbox.com' && url.pathname === '/events/v2')
            )
                return route.abort();
            unexpected.push(url.origin + url.pathname);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/chart-contours.html');
        await page.evaluate(() => {
            document.documentElement.style.fontSize = '130%';
        });
        await expect(page.getByRole('status', { name: 'Fixture ready' })).toHaveText('Ready');
        const trigger = page.getByRole('button', { name: 'Map base: Relief', exact: true });
        await trigger.click();
        await page.getByRole('menuitem', { name: /Charts & detail/ }).click();
        const sheet = page.getByRole('dialog', { name: 'Charts & detail' });
        const controls = sheet.getByRole('group', { name: 'Chart contour bands' });
        await controls.getByRole('textbox', { name: 'Shallow (m)', exact: true }).fill('2');
        await controls.getByRole('textbox', { name: 'Safety (m)', exact: true }).fill('6');
        await controls.getByRole('textbox', { name: 'Deep (m)', exact: true }).fill('20');
        await controls
            .getByRole('checkbox', { name: 'Relief safety marker · not for navigation', exact: true })
            .check();
        // Draft edits do not move the actual map before explicit Apply.
        expect((await readFrame(page)).bold).toEqual(['coarse:5', 'fine:6']);
        await controls.getByRole('button', { name: 'Apply bands', exact: true }).click();
        await expect(controls.getByRole('status')).toHaveText('Chart display updated.');
        await expect(controls).toContainText('Active: 2 / 6 / 20 m.');
        await expect(controls).toContainText('Draft is assumed');
        await expect(controls).toContainText('datum can differ from ENC');
        expect(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        expect(await controls.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`contour-controls-${width}.png`) });
        await page.keyboard.press('Escape');
        await expect(sheet).toHaveCount(0);
        await expect.poll(async () => (await readFrame(page)).bold).toEqual(['coarse:10', 'fine:6']);
        // Both unwrapped sides of the dateline render, including null -> unpainted.
        const frame = await readFrame(page);
        expect(frame.enc[0]).toEqual(frame.background);
        for (const [i, expected] of [
            [1, [139, 188, 221]],
            [2, [166, 204, 230]],
            [3, [216, 233, 245]],
            [4, [255, 255, 255]],
        ] as const)
            expected.forEach((channel, c) =>
                expect(Math.abs(frame.enc[i][c] - (0.95 * channel + 0.05 * frame.background[c]))).toBeLessThanOrEqual(
                    3,
                ),
            );
        // Encoding 0/255 carries no model water-depth claim; amber is only a warning.
        expect(frame.relief[0]).toEqual(frame.background);
        expect(frame.relief[4]).toEqual(frame.background);
        for (const i of [1, 2]) {
            expect(frame.relief[i][0] - frame.relief[i][2]).toBeGreaterThan(80);
            expect(frame.relief[i][3]).toBe(255);
        }
        expect(frame.relief[3][2] - frame.relief[3][0]).toBeGreaterThan(20);
        await page.screenshot({ path: testInfo.outputPath(`contour-frame-${width}.png`) });
        await trigger.click();
        const menu = page.getByRole('menu', { name: 'Map base', exact: true });
        await expect(menu.getByText('Relief safety marker ~6 m · not for navigation', { exact: true })).toBeVisible();
        await expect(menu.getByRole('menuitemradio')).toHaveCount(5);
        await expect(menu.getByRole('menuitemcheckbox')).toHaveCount(1);
        await expect(menu.getByRole('menuitem')).toHaveCount(1);
        expect(
            await menu.evaluate(
                (el) => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().bottom <= innerHeight,
            ),
        ).toBe(true);
        await page.keyboard.press('ArrowUp');
        await expect(menu.getByRole('menuitem', { name: /Charts & detail/ })).toBeFocused();
        await page.keyboard.press('Enter');
        await controls.getByRole('button', { name: 'Reset bands', exact: true }).click();
        await expect(controls).toContainText('Standard chart bands are active.');
        await page.keyboard.press('Escape');
        await expect(sheet).toHaveCount(0);
        await expect.poll(async () => (await readFrame(page)).bold).toEqual(['coarse:5', 'fine:6']);
        await trigger.click();
        await expect(menu.getByText(/Relief safety marker/)).toHaveCount(0);
        expect(unexpected).toEqual([]);
    });
