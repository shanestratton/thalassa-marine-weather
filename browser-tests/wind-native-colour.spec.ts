import { expect, test } from '@playwright/test';
for (const large of [false, true])
    test(
        `production ${large ? 'full-size diagonal' : 'small horizontal'} wind Canvas2D keeps measured slate/red/white hues through trail fading`,
        { tag: '@pixel' },
        async ({ page }, info) => {
            test.setTimeout(120_000);
            await page.setViewportSize({ width: 1000, height: 700 });
            const remote: string[] = [];
            await page.route('**/*', (route) => {
                const url = new URL(route.request().url());
                if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
                remote.push(url.origin);
                return route.abort();
            });
            await page.goto('/e2e/fixtures/wind-native-colour.html' + (large ? '?large' : ''));
            await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
            // Preserve compositor pixels before readback can flush a Canvas2D implementation.
            await page.screenshot({
                path: info.outputPath('native-wind-colours.png'),
                animations: 'allow',
                fullPage: true,
            });
            const results = await page.evaluate(() =>
                [...document.querySelectorAll<HTMLElement>('[data-case]')].map((section) => {
                    const canvas = section.querySelector('canvas')!;
                    const context = canvas.getContext('2d')!;
                    const width = Number.parseFloat(canvas.style.width);
                    const height = Number.parseFloat(canvas.style.height);
                    const scale = canvas.width / width;
                    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
                    const read = (y0: number, y1: number) => {
                        const result = { drawn: 0, slate: 0, red: 0, white: 0, black: 0 };
                        for (let y = Math.floor(y0 * scale); y < y1 * scale; y++)
                            for (let x = Math.floor(width * 0.06 * scale); x < width * 0.94 * scale; x++) {
                                const i = (y * canvas.width + x) * 4;
                                const r = pixels[i],
                                    g = pixels[i + 1],
                                    b = pixels[i + 2],
                                    a = pixels[i + 3];
                                if (a < 32) continue;
                                result.drawn++;
                                if (b >= r + 5 && r < 60 && g < 70 && b < 80) result.slate++;
                                if (r > g + 40 && r > b + 40) result.red++;
                                if (Math.min(r, g, b) >= 240) result.white++;
                                if (Math.max(r, g, b) < 10) result.black++;
                            }
                        return result;
                    };
                    return {
                        name: section.dataset.case!,
                        scale,
                        top: read(height * 0.02, height * 0.14),
                        bottom: read(height * 0.72, height * 0.92),
                        png: canvas.toDataURL(),
                    };
                }),
            );
            const metrics = results.map(({ png: _png, ...metric }) => metric);
            console.info('NATIVE_WIND_RGBA ' + JSON.stringify(metrics));
            await info.attach('native-wind-rgba.json', {
                body: JSON.stringify(metrics, null, 2),
                contentType: 'application/json',
            });
            for (const result of results) {
                await info.attach(result.name + '-raw.png', {
                    body: Buffer.from(result.png.split(',')[1], 'base64'),
                    contentType: 'image/png',
                });
                expect(result.bottom.drawn, result.name + ': production trails draw').toBeGreaterThan(100);
                if (result.name.startsWith('light')) {
                    expect(result.bottom.slate / result.bottom.drawn, result.name + ': raw calm slate').toBeGreaterThan(
                        0.9,
                    );
                    expect(result.top.red / result.top.drawn, result.name + ': raw reef red').toBeGreaterThan(0.9);
                } else
                    expect(result.bottom.white / result.bottom.drawn, result.name + ': raw white').toBeGreaterThan(0.9);
                expect(
                    result.bottom.black / result.bottom.drawn,
                    result.name + ': no black replacement trails',
                ).toBeLessThan(0.01);
            }
            expect(remote).toEqual([]);
        },
    );
