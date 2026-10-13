/**
 * The chart can turn (127-11a), the largest case: an iPad-sized 820 × 1180
 * view turned to 37°, then the device turned on its side. Its rotated wind
 * square is the view's diagonal, about 1437 px a side.
 *
 * It lived in chart-orientation.spec.ts until 2026-10-12. On CI's software GL
 * (Chromium's SwiftShader) the browser was still working off this case when
 * the next test asked it for a context, and that test failed in all four
 * build-127 validation runs, "Test timeout of 30000ms exceeded while setting
 * up 'context'", before any of its own lines ran; its retry, in a fresh
 * browser, passed in 8 s. So this case gets a browser of its own: Playwright
 * gives each set of worker fixtures its own worker, and the worker fixture
 * below is this file's alone, so no other test ever runs in the browser that
 * drew it. The assertions are the ones it had.
 */
import { expect, test as base } from '@playwright/test';
import { openOrientation, windProbes } from './helpers/chartOrientationPage';

const test = base.extend<object, { browserOfItsOwn: string }>({
    browserOfItsOwn: [
        async ({ browserName }, use) => {
            await use(browserName);
        },
        { scope: 'worker', auto: true },
    ],
});

test.describe('the wind field turns with the chart', () => {
    for (const [w, h] of [[820, 1180]] as const) {
        test(`turned to 37° at ${w} x ${h}, then the device turned on its side: still within 2 px`, async ({
            page,
        }) => {
            const errors = await openOrientation(page, { scene: 'wind', bearing: '37', mode: 'turning' });
            await page.setViewportSize({ width: w, height: h });
            await windProbes(page);
            // Width and height swap: the square's side is the same, its centre is not.
            await page.setViewportSize({ width: h, height: w });
            const read = await windProbes(page);
            expect(read.view).toEqual({ width: h, height: w });
            for (const { mapbox, css } of read.probes) {
                expect(Math.abs(css.x - mapbox.x), `x at ${JSON.stringify(mapbox)}`).toBeLessThan(2);
                expect(Math.abs(css.y - mapbox.y), `y at ${JSON.stringify(mapbox)}`).toBeLessThan(2);
            }
            expect(errors).toEqual([]);
        });
    }
});
