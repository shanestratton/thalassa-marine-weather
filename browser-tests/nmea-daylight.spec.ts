import { expect, test, type Page, type TestInfo } from '@playwright/test';

async function setMode(page: Page, name: string) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.locator('main')).toHaveAttribute('data-mode', name);
}

async function stableInstrumentScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<Buffer> {
    await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(
            document
                .getAnimations()
                .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
                .map((animation) => animation.finished.catch(() => undefined)),
        );
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });

    // Chromium can capture a partially repainted SVG after a live theme change even
    // when computed colours and DOM have settled. The reproducer included TWO equal
    // transient frames, so require three consecutive exact captures, not a delay or
    // a pixel tolerance. The final before/after comparison remains byte-for-byte.
    let previous: Buffer | undefined;
    let consecutiveMatches = 0;
    await expect
        .poll(
            async () => {
                const current = await page.screenshot({
                    path: testInfo.outputPath(`${name}.png`),
                    fullPage: true,
                    animations: 'disabled',
                });
                consecutiveMatches = previous?.equals(current) ? consecutiveMatches + 1 : 0;
                previous = current;
                return consecutiveMatches;
            },
            { message: `${name}: three identical instrument frames`, timeout: 15_000 },
        )
        .toBeGreaterThanOrEqual(2);
    return previous!;
}

const paints = (page: Page) =>
    page.evaluate(() => {
        const property = (selector: string, name: string) =>
            window.getComputedStyle(document.querySelector(selector)!).getPropertyValue(name);
        const text = (gauge: string, label: string) => {
            const node = [...document.querySelectorAll(`[data-gauge="${gauge}"] text`)].find(
                (el) => el.textContent === label,
            )!;
            return window.getComputedStyle(node).fill;
        };
        return {
            windFace: property('#qa-port-face stop', 'stop-color'),
            windPort: property('#qa-port-ndl stop', 'stop-color'),
            windStarboard: property('#qa-stbd-ndl stop', 'stop-color'),
            windReading: text('Wind · port', '18.2'),
            headingFace: property('#heading-face stop', 'stop-color'),
            headingReading: text('Heading', '007'),
            heelPort: text('Heel · port', 'PORT'),
            rudderStarboard: text('Rudder · starboard', 'STARBOARD'),
            barometerWarning: property('[data-gauge="Pressure · warning"] g[filter] line', 'stroke'),
            clockFace: property('#bell-dial stop', 'stop-color'),
            staleOpacity: property('[data-gauge="Wind · stale"] svg', 'opacity'),
        };
    });

test.beforeEach(async ({ page }) => {
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
    });
    await page.goto('/tests/fixtures/nmea-daylight.html');
    await expect(page.locator('html')).toHaveClass(/display-light/);
    await expect(page.locator('#qa-port-ndl')).toBeAttached();
});

test('day paint switches live while dark and night retain their exact instrument colours', async ({
    page,
}, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 1100 });
    const light = await paints(page);
    expect(light).toEqual({
        windFace: 'rgb(255, 255, 255)',
        windPort: 'rgb(185, 28, 28)',
        windStarboard: 'rgb(4, 120, 87)',
        windReading: 'rgb(15, 23, 42)',
        headingFace: 'rgb(255, 255, 255)',
        headingReading: 'rgb(15, 23, 42)',
        heelPort: 'rgb(185, 28, 28)',
        rudderStarboard: 'rgb(4, 120, 87)',
        barometerWarning: 'rgb(185, 28, 28)',
        clockFace: 'rgb(255, 250, 240)',
        staleOpacity: '0.45',
    });
    await expect(page.locator('#qa-absent-ndl')).toHaveCount(0);
    await expect(page.locator('[data-gauge="Wind · absent"]')).toContainText('no data');
    await testInfo.attach('light-desktop', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
    });

    await setMode(page, 'dark');
    const dark = await paints(page);
    expect(dark).toEqual({
        windFace: 'rgb(26, 26, 25)',
        windPort: 'rgb(239, 83, 80)',
        windStarboard: 'rgb(37, 177, 103)',
        windReading: 'rgb(255, 255, 255)',
        headingFace: 'rgb(30, 41, 59)',
        headingReading: 'rgb(248, 250, 252)',
        heelPort: 'rgb(251, 113, 133)',
        rudderStarboard: 'rgb(52, 211, 153)',
        barometerWarning: 'rgb(248, 113, 113)',
        clockFace: 'rgb(255, 250, 240)',
        staleOpacity: '0.45',
    });
    const darkImage = await stableInstrumentScreenshot(page, testInfo, 'dark-desktop');
    await testInfo.attach('dark-desktop', { body: darkImage, contentType: 'image/png' });
    await setMode(page, 'night');
    expect(await paints(page)).toEqual(dark);
    await testInfo.attach('night-desktop', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
    });
    await setMode(page, 'light');
    expect(await paints(page)).toEqual(light);
    await setMode(page, 'dark');
    expect(await paints(page)).toEqual(dark);
    const returnedDark = await stableInstrumentScreenshot(page, testInfo, 'returned-dark-desktop');
    await testInfo.attach('returned-dark-desktop', { body: returnedDark, contentType: 'image/png' });
    expect(darkImage.equals(returnedDark), 'Dark screenshot after switching modes').toBe(true);
});

for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
]) {
    test(`daylight instruments stay within their panels at ${viewport.width} × ${viewport.height}`, async ({
        page,
    }, testInfo) => {
        await page.setViewportSize(viewport);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
        const bounds = await page.locator('section svg').evaluateAll((nodes) =>
            nodes.map((node) => {
                const box = node.getBoundingClientRect();
                const parent = node.closest('section')!.getBoundingClientRect();
                return { left: box.left, right: box.right, parentLeft: parent.left, parentRight: parent.right };
            }),
        );
        for (const box of bounds) {
            expect(box.left).toBeGreaterThanOrEqual(box.parentLeft);
            expect(box.right).toBeLessThanOrEqual(box.parentRight + 1);
        }
        await testInfo.attach(`light-${viewport.width}x${viewport.height}`, {
            body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
            contentType: 'image/png',
        });
    });
}

test('clock, wind and position use the measured split pane and restore viewport sizing outside it', async ({
    page,
}) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    const probe = page.getByTestId('pane-size-probe');
    const clock = page.locator('[data-gauge="Clock"]');
    await expect(page.getByTestId('wind-hero-size')).toHaveCSS('height', '209px');
    await expect(page.getByTestId('wind-cell-size')).toHaveCSS('height', '209px');
    await expect(page.getByTestId('position-size')).toHaveCSS('font-size', '48px');
    for (const element of [probe, clock]) {
        await element.evaluate((node) => {
            (node as HTMLElement).style.setProperty('--pane-height', '240px');
            (node as HTMLElement).style.setProperty('--pane-width', '320px');
        });
    }
    expect((await page.getByTestId('wind-hero-size').boundingBox())!.height).toBeCloseTo(45.6, 1);
    expect((await page.getByTestId('wind-cell-size').boundingBox())!.height).toBeCloseTo(45.6, 1);
    expect((await clock.locator('.nmea-clock').boundingBox())!.height).toBeCloseTo(168, 1);
    // WebKit serializes this calc as 35.200001px; assert the rendered size, not float formatting.
    await expect
        .poll(() => page.getByTestId('position-size').evaluate((node) => parseFloat(getComputedStyle(node).fontSize)))
        .toBeCloseTo(35.2, 2);
    for (const element of [probe, clock]) {
        await element.evaluate((node) => {
            (node as HTMLElement).style.removeProperty('--pane-height');
            (node as HTMLElement).style.removeProperty('--pane-width');
        });
    }
    await expect(page.getByTestId('wind-hero-size')).toHaveCSS('height', '209px');
    await expect(page.getByTestId('position-size')).toHaveCSS('font-size', '48px');
    expect((await clock.locator('.nmea-clock').boundingBox())!.height).toBeGreaterThan(168);
});
