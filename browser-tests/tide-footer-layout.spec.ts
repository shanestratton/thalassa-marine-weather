import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { applyWideFonts } from '../e2e/helpers/wideFonts';

const unexpectedByPage = new WeakMap<Page, string[]>();
const errorsByPage = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
    const unexpected: string[] = [];
    unexpectedByPage.set(page, unexpected);
    const errors: string[] = [];
    errorsByPage.set(page, errors);
    page.on('pageerror', (error) => errors.push(error.message));
    await applyWideFonts(page);
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (['127.0.0.1', 'localhost'].includes(url.hostname) || ['blob:', 'data:'].includes(url.protocol))
            return route.continue();
        unexpected.push(url.origin + url.pathname);
        return route.abort();
    });
});
test.afterEach(({ page }) => {
    expect(unexpectedByPage.get(page)).toEqual([]);
    expect(errorsByPage.get(page)).toEqual([]);
});

/** Caption/font ResizeObservers and the canvas effect do not finish with DOM
 * visibility. Require the original real-pixel threshold within a bounded paint
 * interval and retain every sample, including a blank first paint on failure. */
async function drawnPixels(canvas: Locator, caption: Locator, info: TestInfo) {
    const samples: Array<Record<string, number>> = [];
    let actual = { curve: 0, axis: 0, visibleHeight: 0 };
    try {
        await expect
            .poll(
                async () => {
                    const captionBox = (await caption.boundingBox())!;
                    const sample = await canvas.evaluate((el: HTMLCanvasElement, captionBottom) => {
                        const ctx = el.getContext('2d')!;
                        const data = ctx.getImageData(0, 0, el.width, el.height).data;
                        const axisTop = el.height - 14 * devicePixelRatio;
                        const visibleTop = Math.ceil((captionBottom - el.getBoundingClientRect().y) * devicePixelRatio);
                        let curve = 0,
                            axis = 0;
                        for (let y = Math.max(0, visibleTop); y < el.height; y++)
                            for (let x = 0; x < el.width; x++) {
                                const i = (y * el.width + x) * 4;
                                if (
                                    y < axisTop &&
                                    data[i + 1] > 100 &&
                                    (data[i] > data[i + 2] + 30 || data[i + 2] > data[i] + 30) &&
                                    data[i + 3] > 128
                                )
                                    curve++;
                                if (
                                    y >= axisTop &&
                                    data[i] > 100 &&
                                    data[i + 1] > 100 &&
                                    data[i + 2] > 100 &&
                                    data[i + 3] > 150
                                )
                                    axis++;
                            }
                        const transform = ctx.getTransform();
                        return {
                            atMs: performance.now(),
                            curve: curve / devicePixelRatio ** 2,
                            axis: axis / devicePixelRatio ** 2,
                            visibleHeight: (axisTop - visibleTop) / devicePixelRatio,
                            width: el.width,
                            height: el.height,
                            scaleX: transform.a,
                            scaleY: transform.d,
                        };
                    }, captionBox.y + captionBox.height);
                    samples.push(sample);
                    actual = sample;
                    return sample.curve;
                },
                { timeout: 5000, message: 'The actual tide curve below the settled caption is painted' },
            )
            .toBeGreaterThan(100);
        return actual;
    } finally {
        await info.attach('canvas-paint-readiness', { body: JSON.stringify(samples), contentType: 'application/json' });
    }
}

for (const width of [300, 375, 430]) {
    for (const large of [false, true]) {
        test(`${width}px ${large ? '130%' : 'normal'}: tide attribution stays inside the original card`, async ({
            page,
        }, info) => {
            await page.setViewportSize({ width, height: 850 });
            await page.goto('/e2e/fixtures/wind-tide.html?mode=dark&height=180&provenance=1');
            if (large) await page.addStyleTag({ content: 'html{font-size:130%}' });
            await expect(page.getByTestId('tide-station-name')).toBeVisible();
            const geometry = await page.evaluate(() => {
                const rect = (selector: string) => {
                    const r = document.querySelector(selector)!.getBoundingClientRect();
                    return { x: r.x, y: r.y, width: r.width, height: r.height };
                };
                return {
                    card: rect('[data-testid="tide-card"]'),
                    model: rect('[data-testid="model-strip"]'),
                    page: {
                        width: document.documentElement.scrollWidth,
                        height: document.documentElement.scrollHeight,
                    },
                };
            });
            await info.attach('card-and-page-geometry', {
                body: JSON.stringify(geometry),
                contentType: 'application/json',
            });
            await writeFile(info.outputPath('geometry.json'), JSON.stringify(geometry));
            await page.screenshot({ path: info.outputPath('tide-card.png') });
            const card = page.getByTestId('tide-card');
            const plot = page.getByTestId('tide-plot');
            const footer = page.getByTestId('tide-source-footer');
            const canvas = plot.locator('canvas');
            const [plotBox, footerBox, canvasBox] = await Promise.all([
                plot.boundingBox(),
                footer.boundingBox(),
                canvas.boundingBox(),
            ]);
            expect(geometry.card.height).toBe(180);
            expect(geometry.page).toEqual({ width, height: 850 });
            expect(footerBox!.height).toBe(44);
            expect(plotBox!.y + plotBox!.height).toBeLessThanOrEqual(footerBox!.y);
            expect(canvasBox!.y + canvasBox!.height).toBeLessThanOrEqual(footerBox!.y);
            expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(geometry.card.y + geometry.card.height);
            const caption = page.getByTestId('tide-caption-band');
            const captionBox = (await caption.boundingBox())!;
            const captionOverlap = await caption.evaluate((el) => {
                const [left, right] = [...el.children].map((child) => child.getBoundingClientRect());
                return (
                    Math.min(left.right, right.right) > Math.max(left.left, right.left) + 1 &&
                    Math.min(left.bottom, right.bottom) > Math.max(left.top, right.top) + 1
                );
            });
            expect(captionOverlap).toBe(false);
            expect(captionBox.y + captionBox.height).toBeLessThan(canvasBox!.y + canvasBox!.height - 14);
            const pixels = await drawnPixels(canvas, caption, info);
            expect(pixels.curve).toBeGreaterThan(100);
            expect(pixels.axis).toBeGreaterThan(30);
            await info.attach('actual-canvas-pixels', {
                body: JSON.stringify(pixels),
                contentType: 'application/json',
            });
            const source = page.getByRole('button', { name: 'Source and datum' });
            const offline = page.getByRole('button', { name: 'Offline tides', exact: true });
            for (const action of [source, offline]) {
                const box = (await action.boundingBox())!;
                expect(box.width).toBeGreaterThanOrEqual(44);
                expect(box.height).toBeGreaterThanOrEqual(44);
                expect(box.y).toBeGreaterThanOrEqual(footerBox!.y);
                expect(box.x + box.width).toBeLessThanOrEqual(footerBox!.x + footerBox!.width);
                expect(await action.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
                expect(await action.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
            }
            await expect(source).toHaveAccessibleDescription('MSQ/BOM · Station LAT · SCARBOROUGH BOAT HARBOUR');
            await source.focus();
            await page.keyboard.press('Enter');
            const detail = page.getByRole('dialog', { name: 'Tide source', exact: true });
            await expect(detail).toBeVisible();
            await expect(detail).toContainText('MSQ · Station LAT · SCARBOROUGH BOAT HARBOUR');
            await expect(detail.getByRole('link', { name: 'Source table' })).toHaveAttribute(
                'href',
                'https://www.msq.qld.gov.au/tides',
            );
            await expect(detail.getByRole('link', { name: 'Licence' })).toHaveAttribute(
                'href',
                'https://www.msq.qld.gov.au/copyright',
            );
            await expect(page.getByRole('region', { name: 'Wind versus tide details' })).toHaveCount(0);
            await page.keyboard.press('Escape');
            await expect(detail).toHaveCount(0);
            await expect(source).toBeFocused();
            await offline.click();
            await expect(page.getByRole('dialog', { name: 'Offline tide tables', exact: true })).toBeVisible();
            await expect(page.getByRole('region', { name: 'Wind versus tide details' })).toHaveCount(0);
            await page.keyboard.press('Escape');
            await expect(page.getByRole('dialog', { name: 'Offline tide tables', exact: true })).toHaveCount(0);
            expect(await card.boundingBox()).toEqual(geometry.card);
            expect(await page.getByTestId('model-strip').boundingBox()).toEqual(geometry.model);
            expect(
                await page.evaluate(() => ({
                    width: document.documentElement.scrollWidth,
                    height: document.documentElement.scrollHeight,
                })),
            ).toEqual(geometry.page);
        });
    }
}

for (const width of [300, 375, 430]) {
    for (const large of [false, true]) {
        for (const height of [85, 150]) {
            test(`${width}px ${large ? '130%' : 'normal'} ${height}px compact: values and curve keep their space`, async ({
                page,
            }, info) => {
                await page.setViewportSize({ width, height: width === 300 ? 640 : width === 375 ? 667 : 932 });
                await page.goto(`/e2e/fixtures/wind-tide.html?mode=dark&provenance=1&height=${height}&late=1`);
                if (large) await page.addStyleTag({ content: 'html{font-size:130%}' });
                const card = page.getByTestId('tide-card');
                const source = page.getByRole('button', { name: /source and datum/i });
                await expect(page.getByTestId('tide-source-disclosure')).toBeVisible();
                await expect(page.getByTestId('tide-source-footer')).toHaveCount(0);
                const before = await page.evaluate(() => {
                    const rect = (s: string) => {
                        const b = document.querySelector(s)!.getBoundingClientRect();
                        return { x: b.x, y: b.y, width: b.width, height: b.height };
                    };
                    return {
                        card: rect('[data-testid="tide-card"]'),
                        model: rect('[data-testid="model-strip"]'),
                        page: {
                            width: document.documentElement.scrollWidth,
                            height: document.documentElement.scrollHeight,
                        },
                    };
                });
                expect(before.card.height).toBe(height);
                expect(before.page.width).toBe(width);
                expect(before.page.height).toBe(width === 300 ? 640 : width === 375 ? 667 : 932);
                const header = page.getByTestId('tide-caption-band');
                const layout = await header.evaluate((el) => {
                    const [left, right] = [...el.children].map((c) => c.getBoundingClientRect());
                    const box = el.getBoundingClientRect();
                    return {
                        overlap:
                            Math.min(left.right, right.right) > Math.max(left.left, right.left) + 1 &&
                            Math.min(left.bottom, right.bottom) > Math.max(left.top, right.top) + 1,
                        left: left.left - box.left,
                        right: right.right - box.right,
                        bottom: box.bottom,
                    };
                });
                expect(layout.overlap).toBe(false);
                expect(layout.left).toBeGreaterThanOrEqual(0);
                expect(layout.right).toBeLessThanOrEqual(0);
                await expect(page.getByTestId('tide-day-cue')).toHaveCount(2);
                const sourceBox = (await source.boundingBox())!;
                expect(sourceBox.width).toBeGreaterThanOrEqual(44);
                expect(sourceBox.height).toBeGreaterThanOrEqual(44);
                expect(await source.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
                const canvas = page.getByTestId('tide-plot').locator('canvas');
                const actual = await drawnPixels(canvas, header, info);
                expect(actual.visibleHeight).toBeGreaterThan(10);
                expect(actual.curve).toBeGreaterThan(100);
                expect(actual.axis).toBeGreaterThan(30);
                await page.screenshot({ path: info.outputPath('compact-tide-card.png') });
                await writeFile(
                    info.outputPath('geometry.json'),
                    JSON.stringify({ width, large, height, browser: info.project.name, geometry: before }),
                );
                await source.click();
                const details = page.getByRole('dialog', { name: 'Tide source', exact: true });
                await expect(details).toContainText('SCARBOROUGH BOAT HARBOUR');
                await expect(details).toContainText('Station LAT');
                await expect(details.getByRole('link', { name: 'Source table' })).toBeVisible();
                await expect(page.getByRole('region', { name: 'Wind versus tide details' })).toHaveCount(0);
                await details.getByRole('button', { name: 'Offline tides' }).click();
                await expect(page.getByRole('dialog', { name: 'Offline tide tables', exact: true })).toBeVisible();
                await page.keyboard.press('Escape');
                await expect(page.getByRole('dialog', { name: 'Offline tide tables', exact: true })).toHaveCount(0);
                expect(await card.boundingBox()).toEqual(before.card);
                expect(await page.getByTestId('model-strip').boundingBox()).toEqual(before.model);
                expect(
                    await page.evaluate(() => ({
                        width: document.documentElement.scrollWidth,
                        height: document.documentElement.scrollHeight,
                    })),
                ).toEqual(before.page);
            });
        }
    }
}

test('short all-day card keeps the full four-event table in its source disclosure', async ({ page }) => {
    await page.setViewportSize({ width: 300, height: 640 });
    await page.goto('/e2e/fixtures/wind-tide.html?mode=dark&provenance=1&height=85&allDay=1');
    await page.addStyleTag({ content: 'html{font-size:130%}' });
    const source = page.getByRole('button', { name: 'All tide events; source and datum' });
    await expect(source).toBeVisible();
    await expect(source).not.toContainText('1.0');
    await source.click();
    const events = page.getByLabel('All tide events', { exact: true });
    await expect(events.locator('p')).toHaveCount(4);
    await expect(events).toContainText('High 04:00 · 2.0 m');
    await expect(events).toContainText('Low 10:00 · 0.4 m');
    await expect(events).toContainText('High 16:00 · 2.0 m');
    await expect(events).toContainText('Low 22:00 · 0.4 m');
});
