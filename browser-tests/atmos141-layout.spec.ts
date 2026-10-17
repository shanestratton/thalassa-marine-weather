import { test, expect } from '@playwright/test';

/** Local placeholder font bitmaps, not provider imagery; actual controls and image/line Mapbox sources. */
function syntheticGlyphs() {
    const integer = (value: number): number[] => {
        const bytes: number[] = [];
        do {
            const next = value & 127;
            value >>>= 7;
            bytes.push(next | (value ? 128 : 0));
        } while (value);
        return bytes;
    };
    const bytes = (field: number, value: number[]) => [...integer(field * 8 + 2), ...integer(value.length), ...value];
    const text = (field: number, value: string) => bytes(field, [...new TextEncoder().encode(value)]);
    const number = (field: number, value: number) => [...integer(field * 8), ...integer(value)];
    const glyphs = Array.from({ length: 95 }, (_, index) =>
        bytes(3, [
            ...number(1, index + 32),
            ...bytes(2, Array((8 + 6) * (12 + 6)).fill(180)),
            ...number(3, 8),
            ...number(4, 12),
            ...number(5, 0),
            ...number(6, 20),
            ...number(7, 9),
        ]),
    ).flat();
    return Buffer.from(
        bytes(1, [...text(1, 'Open Sans Regular,Arial Unicode MS Regular'), ...text(2, '0-255'), ...glyphs]),
    );
}

for (const width of [300, 375])
    test(`bounded atmosphere controls at ${width}px and 130% text`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 780 });
        await page.clock.setFixedTime(new Date('2026-10-17T05:00:00Z'));
        const outbound: string[] = [],
            errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.pathname.startsWith('/fixture-glyphs/'))
                return route.fulfill({ status: 200, contentType: 'application/x-protobuf', body: syntheticGlyphs() });
            if (
                url.protocol === 'blob:' ||
                url.protocol === 'data:' ||
                ['127.0.0.1', 'localhost'].includes(url.hostname)
            )
                return route.continue();
            outbound.push(url.origin + url.pathname);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/atmos141.html');
        await page.addStyleTag({ content: 'html {font-size:130%}' });
        await page.getByRole('button', { name: 'Show layer key' }).click();
        const panel = page.getByRole('region', { name: 'Atmospheric model controls' });
        try {
            await expect(panel.getByRole('status')).toHaveText(/Model forecast/, { timeout: 30_000 });
        } catch (error) {
            await info.attach('render-diagnostic.json', {
                body: JSON.stringify(
                    { evidence: await page.evaluate(() => window.__atmos141.evidence()), errors },
                    null,
                    2,
                ),
                contentType: 'application/json',
            });
            throw error;
        }
        await expect(panel).toContainText('Model visibility · low skill');
        const before = (await page.evaluate(() => window.__atmos141.evidence())) as {
            canvas: { width: number; height: number };
            requests: string[];
            overlayIds: string[];
        };
        expect(before.overlayIds.length).toBe(5); // Two GFS image layers and three pressure-symbol layers.
        expect(before.requests.filter((url) => url.endsWith('?model=gfs') && url.includes('.bin'))).toHaveLength(2);
        expect(before.requests.filter((url) => url.endsWith('?model=ecmwf') && url.includes('.bin'))).toHaveLength(2);
        const extent = async () => {
            const state = (await page.evaluate(() => window.__atmos141.evidence())) as Record<string, unknown>;
            expect(state.scrollWidth).toBe(width);
            expect(state.scrollHeight).toBe(780);
            expect(state.canvas).toEqual(before.canvas);
            expect(state.remoteAttempts).toEqual([]);
            expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        };
        await extent();
        await panel.getByRole('button', { name: 'Info' }).click();
        await expect(panel).toContainText('not proof of fog');
        await extent();
        await page.screenshot({ path: info.outputPath('atmosphere-controls.png') });
        const credits = page.getByTestId('obs-credits-rollup');
        expect((await credits.boundingBox())!.height).toBe(44);
        await credits.getByRole('button').click();
        const dialog = page.getByRole('dialog', { name: 'Map credits & source status' });
        await expect(dialog).toContainText('Contains modified ECMWF IFS open data');
        await expect(dialog).toContainText('NOAA / NCEP GFS');
        expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        await extent();
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();

        await page.evaluate(() => window.__atmos141.pressureOnly('ecmwf'));
        await expect(panel.getByRole('status')).toHaveText(/Model forecast/);
        const slider = panel.getByRole('slider', { name: 'Atmospheric forecast time' });
        await expect(slider).toHaveAttribute('max', '240');
        await slider.press('End');
        await expect(panel.getByRole('status')).toHaveText('Model forecast · 10-27 00:00 UTC');
        await expect
            .poll(
                async () =>
                    ((await page.evaluate(() => window.__atmos141.evidence())) as { overlayIds: string[] }).overlayIds
                        .length,
            )
            .toBe(4);
        await extent();
        await page.evaluate(() => window.__atmos141.pressureOnly('gfs'));
        await expect(slider).toHaveAttribute('max', '168');
        // The same selected UTC is beyond GFS coverage; it must hold, not show its endpoint.
        await expect(panel.getByRole('status')).toContainText('outside actual source coverage');
        await panel.getByRole('button', { name: 'Now', exact: true }).click();
        await expect(panel.getByRole('status')).toHaveText(/Model forecast/);
        await slider.press('End');
        await expect(panel.getByRole('status')).toHaveText('Model forecast · 10-24 00:00 UTC');

        await panel.getByRole('button', { name: 'Now', exact: true }).click();
        await expect(panel.getByRole('status')).toHaveText(/Model forecast/);
        await page.evaluate(() => window.__atmos141.delay());
        await slider.press('End');
        await expect(panel.getByRole('status')).toContainText('Loading');
        await expect
            .poll(
                async () =>
                    ((await page.evaluate(() => window.__atmos141.evidence())) as { overlayIds: string[] }).overlayIds
                        .length,
            )
            .toBe(0);
        await page.evaluate(() => {
            window.__atmos141.off();
            window.__atmos141.resolve();
        });
        await expect(panel).toHaveCount(0);
        await expect
            .poll(
                async () =>
                    ((await page.evaluate(() => window.__atmos141.evidence())) as { overlayIds: string[] }).overlayIds
                        .length,
            )
            .toBe(0);
        await page.evaluate(() => window.__atmos141.pressureOnly('icon'));
        await page.getByRole('button', { name: 'Show layer key' }).click();
        await expect(panel.getByRole('status')).toContainText('ICON long-range pressure unavailable');
        await expect(panel.getByRole('slider')).toHaveCount(0);
        await extent();
        expect(errors).toEqual([]);
        expect(outbound).toEqual([]);
        expect(
            ((await page.evaluate(() => window.__atmos141.evidence())) as { mapErrors: string[] }).mapErrors,
        ).toEqual([]);
        await info.attach('source-and-extent.json', {
            body: JSON.stringify(await page.evaluate(() => window.__atmos141.evidence()), null, 2),
            contentType: 'application/json',
        });
    });
