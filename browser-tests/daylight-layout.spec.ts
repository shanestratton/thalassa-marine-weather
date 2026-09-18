import { expect, test, type Page } from '@playwright/test';

test('sunlight surfaces and text remain legible after passage CSS loads', async ({ page }) => {
    await page.goto('/e2e/fixtures/daylight.html');
    await expect(page.locator('html')).toHaveClass(/display-light/);
    await expect(page.getByTestId('neutral-card')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(page.getByTestId('dense-card')).toHaveCSS('background-color', 'rgba(248, 250, 252, 0.97)');
    await expect(page.getByTestId('passage-card')).toHaveCSS('background-color', 'rgba(248, 250, 252, 0.98)');
    await expect(page.locator('.bio-header')).toHaveCSS('color', 'rgb(15, 23, 42)');
    await expect(page.getByTestId('filled-cta')).toHaveCSS('color', 'rgb(255, 255, 255)');
    for (const kind of ['seamark-popup', 'mpa-popup', 'ntm-popup', 'tide-station-popup']) {
        await expect(page.getByTestId(kind).locator('.mapboxgl-popup-content')).toHaveCSS(
            'background-color',
            'rgb(255, 255, 255)',
        );
        await expect(page.getByTestId(kind).locator('p')).toHaveCSS('color', 'rgb(15, 23, 42)');
    }
    const gradient = await page.getByTestId('gradient-card').evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(gradient).toContain('rgb(248, 250, 252)');
    expect(gradient).toContain('rgb(226, 232, 240)');

    const ratios = await page.locator('[data-contrast]').evaluateAll((elements) => {
        const luminance = (rgb: number[]) =>
            rgb
                .map((v) => v / 255)
                .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
                .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        return elements.map((element) => {
            const rgb = getComputedStyle(element)
                .color.match(/[\d.]+/g)!
                .map(Number)
                .slice(0, 3);
            // The fixture's solid white card is asserted above.
            return { label: element.className, ratio: 1.05 / (luminance(rgb) + 0.05) };
        });
    });
    for (const { label, ratio } of ratios) expect(ratio, label).toBeGreaterThanOrEqual(4.5);

    await page.getByRole('button', { name: 'Toggle day' }).click();
    await expect(page.locator('html')).not.toHaveClass(/display-light/);
    await expect(page.getByTestId('passage-card')).toHaveCSS('background-color', 'rgba(8, 16, 28, 0.75)');
    await expect(page.locator('.bio-header')).toHaveCSS('color', 'rgb(255, 255, 255)');
    const dark = await page.getByTestId('gradient-card').evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(dark).not.toBe(gradient);
    await page.getByRole('button', { name: 'Toggle day' }).click();
    await expect(page.getByTestId('passage-card')).toHaveCSS('background-color', 'rgba(248, 250, 252, 0.98)');
});

type HourDraw = { text: string; color: string; font: string; x: number; y: number; align: string };
type TracedCanvas = HTMLCanvasElement & { glassHourDraws?: HourDraw[] };

/**
 * Resolve actual CSS colors through the browser (including Tailwind's OKLCH),
 * then composite backgrounds, text alpha, every ancestor's group opacity and
 * the app's night scrim. A white card assumption misses the original bug.
 */
function measureGlassContrast(elements: Element[]) {
    type RGBA = [number, number, number, number];
    const parser = document.createElement('canvas').getContext('2d')!;
    const rgba = (color: string): RGBA => {
        parser.clearRect(0, 0, 1, 1);
        parser.fillStyle = color;
        parser.fillRect(0, 0, 1, 1);
        const pixel = parser.getImageData(0, 0, 1, 1).data;
        return [pixel[0], pixel[1], pixel[2], pixel[3] / 255];
    };
    const over = (front: RGBA, back: RGBA): RGBA => {
        const alpha = front[3] + back[3] * (1 - front[3]);
        if (!alpha) return [0, 0, 0, 0];
        return [
            ...[0, 1, 2].map((i) => (front[i] * front[3] + back[i] * back[3] * (1 - front[3])) / alpha),
            alpha,
        ] as RGBA;
    };
    const luminance = (pixel: RGBA) =>
        pixel
            .slice(0, 3)
            .map((v) => v / 255)
            .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
            .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const scrim = document.querySelector('[data-testid="night-scrim"]');
    const scrimColor: RGBA = scrim ? rgba(getComputedStyle(scrim).backgroundColor) : [0, 0, 0, 0];
    return elements.flatMap((element) => {
        // TideGraph's labels overlay a sibling chart rather than inheriting
        // its background. Include the real pixel under each DOM caption and
        // that chart's CSS surfaces at their common stacking ancestor.
        let chartAncestor: Element | null = null;
        let chartBackdrop: RGBA = [0, 0, 0, 0];
        if (!(element instanceof HTMLCanvasElement) && element.closest('[data-testid="tide-card"]')) {
            const chart = element.closest('[data-testid="tide-card"]')!.querySelector('canvas')!;
            const textBox = element.getBoundingClientRect();
            const chartBox = chart.getBoundingClientRect();
            const x = textBox.left + textBox.width / 2 - chartBox.left;
            const y = textBox.top + textBox.height / 2 - chartBox.top;
            if (x >= 0 && x < chartBox.width && y >= 0 && y < chartBox.height) {
                const scale = chart.width / chartBox.width;
                const pixel = chart
                    .getContext('2d')!
                    .getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1).data;
                chartBackdrop = [pixel[0], pixel[1], pixel[2], pixel[3] / 255];
                chartAncestor = element.parentElement;
                while (chartAncestor && !chartAncestor.contains(chart)) chartAncestor = chartAncestor.parentElement;
                for (let node: Element | null = chart; node && node !== chartAncestor; node = node.parentElement) {
                    const style = getComputedStyle(node);
                    chartBackdrop = over(chartBackdrop, rgba(style.backgroundColor));
                    chartBackdrop[3] *= Number(style.opacity);
                }
            }
        }
        const compose = (pixel: RGBA) => {
            for (let node: Element | null = element; node; node = node.parentElement) {
                const style = getComputedStyle(node);
                if (style.backgroundImage !== 'none')
                    throw new Error('Fixture requires solid/translucent CSS surfaces');
                if (node === chartAncestor) pixel = over(pixel, chartBackdrop);
                pixel = over(pixel, rgba(style.backgroundColor));
                pixel[3] *= Number(style.opacity);
            }
            return over(scrimColor, over(pixel, [255, 255, 255, 1]));
        };
        const measure = (label: string, ink: RGBA, localBackground: RGBA = [0, 0, 0, 0]) => {
            const foreground = compose(ink);
            const background = compose(localBackground);
            const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
            return { label, ratio: (lighter + 0.05) / (darker + 0.05), foreground, background };
        };
        if (element instanceof HTMLCanvasElement) {
            const ctx = element.getContext('2d')!;
            const scale = element.width / element.getBoundingClientRect().width;
            return ((element as TracedCanvas).glassHourDraws ?? []).map((draw) => {
                // TideCanvas paints the area gradient after the text. Sampling
                // beside a glyph gives that actual translucent overlay, which
                // must be composited over both the ink and the card below it.
                const pixel = ctx.getImageData(
                    Math.round((draw.x + 18) * scale),
                    Math.floor(draw.y * scale),
                    1,
                    1,
                ).data;
                const overlay: RGBA = [pixel[0], pixel[1], pixel[2], pixel[3] / 255];
                return measure(`tide hour ${draw.text}`, over(overlay, rgba(draw.color)), overlay);
            });
        }
        return [measure(element.textContent?.trim() ?? '', rgba(getComputedStyle(element).color))];
    });
}

async function openGlassFixture(page: Page) {
    const unexpectedRequests: string[] = [];
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.origin === 'http://127.0.0.1:4199' && !url.pathname.startsWith('/api/')) return route.continue();
        unexpectedRequests.push(url.origin + url.pathname);
        return route.abort();
    });
    await page.addInitScript(() => {
        const originalFill = CanvasRenderingContext2D.prototype.fillText;
        const originalClear = CanvasRenderingContext2D.prototype.clearRect;
        CanvasRenderingContext2D.prototype.clearRect = function (...args) {
            (this.canvas as TracedCanvas).glassHourDraws = [];
            return originalClear.apply(this, args);
        };
        CanvasRenderingContext2D.prototype.fillText = function (...args) {
            if (/^(00|04|08|12|16|20)$/.test(args[0])) {
                const canvas = this.canvas as TracedCanvas;
                (canvas.glassHourDraws ??= []).push({
                    text: args[0],
                    color: String(this.fillStyle),
                    font: this.font,
                    x: args[1],
                    y: args[2],
                    align: this.textAlign,
                });
            }
            return originalFill.apply(this, args);
        };
    });
    await page.goto('/e2e/fixtures/glass-legibility.html');
    await expect(page.locator('.glass-metric-heading')).toHaveCount(16);
    await expect(page.locator('.glass-forecast-caption')).toHaveCount(7);
    await expect(page.locator('.glass-tide-caption')).toHaveCount(5);
    // The real cell wrapper fades in on mount; measure its settled appearance
    // while still accounting for every persistent ancestor opacity below.
    await expect(page.locator('.metric-swap-enter').first()).toHaveCSS('opacity', '1');
    await expect
        .poll(() => page.locator('canvas').evaluate((el) => (el as TracedCanvas).glassHourDraws?.length))
        .toBe(6);
    return unexpectedRequests;
}

for (const { viewport, pane } of [
    { viewport: 320, pane: 320 },
    { viewport: 390, pane: 390 },
    { viewport: 1024, pane: 669 },
]) {
    test(`Glass titles retain contrast and geometry at ${pane}px through live theme changes`, async ({ page }) => {
        // Four complete theme/contrast/canvas passes also run beside the unit
        // release gate on shared hosts; leave room without retrying assertions.
        test.setTimeout(60_000);
        await page.setViewportSize({ width: viewport, height: 1100 });
        const unexpectedRequests = await openGlassFixture(page);
        const cards = page.locator(
            '[aria-label="Weather metrics dashboard"], [data-testid="secondary-metrics"], [data-testid="daily-summary"], [data-testid="tide-card"]',
        );
        const geometry = () =>
            cards.evaluateAll((elements) =>
                elements.map((el) => {
                    const rect = el.getBoundingClientRect();
                    return { width: rect.width, height: rect.height };
                }),
            );
        const initialGeometry = await geometry();
        expect(initialGeometry[0]).toEqual({ width: pane - 16, height: 163 });
        const activeWarning = page.getByRole('button', { name: '1 active weather warnings' });
        const warningText = activeWarning.locator(':scope > span, :scope > div');
        await expect(warningText).toHaveText(['Warnings', '1']);
        const warningSize = await activeWarning.evaluate((el) => ({ width: el.clientWidth, height: el.clientHeight }));
        const canvas = page.locator('canvas');
        const originalCanvas = await canvas.elementHandle();

        for (const mode of ['light', 'dark', 'night', 'light'] as const) {
            await page.getByRole('button', { name: mode, exact: true }).click();
            await expect(page.getByTestId('glass-background')).toHaveAttribute('data-mode', mode);
            await expect(page.getByTestId('glass-background')).toHaveCSS(
                'background-color',
                mode === 'light' ? 'rgb(226, 232, 240)' : 'rgb(0, 0, 0)',
            );
            await expect(page.getByTestId('glass-pane')).toHaveCSS('width', `${pane}px`);
            if (mode === 'night')
                await expect(page.getByTestId('night-scrim')).toHaveCSS('background-color', 'rgba(69, 10, 10, 0.25)');
            // Both warning words and the count badge must remain readable on
            // their own solid status surfaces, including beneath the scrim.
            for (const result of await warningText.evaluateAll(measureGlassContrast)) {
                expect
                    .soft(
                        result.ratio,
                        `${mode}: active warning ${result.label}; ink ${result.foreground}; background ${result.background}`,
                    )
                    .toBeGreaterThanOrEqual(4.5);
            }
            expect(await activeWarning.evaluate((el) => ({ width: el.clientWidth, height: el.clientHeight }))).toEqual(
                warningSize,
            );
            const titles = page.locator(
                '.glass-metric-heading, .glass-forecast-caption, .glass-clear-status, .glass-tide-caption',
            );
            await expect(page.locator('.glass-metric-heading-row').first()).toHaveCSS(
                'opacity',
                mode === 'light' ? '1' : '0.9',
            );
            for (const result of await titles.evaluateAll(measureGlassContrast)) {
                expect(
                    result.ratio,
                    `${mode}: ${result.label}; ink ${result.foreground}; background ${result.background}`,
                ).toBeGreaterThanOrEqual(mode === 'light' ? 7 : 4.5);
            }

            // Inspect text bounds and clipping ancestors, including each grid
            // cell. A card can stay the same size while its title overflows.
            const overflow = await titles.or(warningText).evaluateAll((elements) =>
                elements.flatMap((el) => {
                    const range = document.createRange();
                    range.selectNodeContents(el);
                    const text = range.getBoundingClientRect();
                    for (let node: HTMLElement | null = el.parentElement; node; node = node.parentElement) {
                        const style = getComputedStyle(node);
                        const isCell = node.parentElement?.classList.contains('grid');
                        if (isCell || ['hidden', 'clip'].includes(style.overflow)) {
                            const box = node.getBoundingClientRect();
                            if (
                                text.left < box.left - 1 ||
                                text.right > box.right + 1 ||
                                text.top < box.top - 1 ||
                                text.bottom > box.bottom + 1
                            ) {
                                return [{ label: el.textContent, text: text.toJSON(), box: box.toJSON() }];
                            }
                        }
                    }
                    return [];
                }),
            );
            expect(overflow, `${mode} clipped labels`).toEqual([]);
            expect(await geometry()).toEqual(initialGeometry);

            await expect
                .poll(() => canvas.evaluate((el) => (el as TracedCanvas).glassHourDraws?.[0]?.color))
                .toBe(mode === 'light' ? '#334155' : '#cbd5e1');
            const hourDraws = await canvas.evaluate((el) => ({
                draws: (el as TracedCanvas).glassHourDraws!,
                width: el.getBoundingClientRect().width,
                height: el.getBoundingClientRect().height,
            }));
            expect(hourDraws.draws.map((draw) => draw.text)).toEqual(['00', '04', '08', '12', '16', '20']);
            hourDraws.draws.forEach((draw, index) => {
                expect(draw.font).toBe('600 12px system-ui, sans-serif');
                expect(draw.x).toBeCloseTo((index / 6) * hourDraws.width);
                expect(draw.y).toBe(hourDraws.height - 1);
                expect(draw.align).toBe(index === 0 ? 'left' : 'center');
            });
            for (const result of await canvas.evaluateAll(measureGlassContrast)) {
                expect(result.ratio, `${mode}: ${result.label}`).toBeGreaterThanOrEqual(mode === 'light' ? 7 : 4.5);
            }
            expect(await canvas.evaluate((el, original) => el === original, originalCanvas)).toBe(true);
            // Existing small live units and bold title sizing are untouched.
            await expect(page.locator('.glass-metric-heading').first()).toHaveCSS('font-size', '12px');
            await expect(page.locator('.glass-metric-heading').first()).toHaveCSS('font-weight', '700');
            await expect(page.locator('[aria-label="Weather metrics dashboard"] .text-slate-400').first()).toHaveCSS(
                'font-weight',
                '500',
            );
        }
        expect(unexpectedRequests, 'Fixture must not contact weather/account backends').toEqual([]);
    });
}
