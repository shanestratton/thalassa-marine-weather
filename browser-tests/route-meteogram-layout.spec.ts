import { expect, test } from '@playwright/test';
for (const width of [300, 375]) {
    test(`the actual route report samples aboard, fits ${width}px and exports the same UTC weather`, async ({
        page,
    }, info) => {
        test.setTimeout(60_000);
        const errors: string[] = [],
            weatherRequests: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.pathname.includes('proxy-openmeteo')) weatherRequests.push(url.pathname);
            return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
        });
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'canShare', { value: () => false, configurable: true });
        });
        await page.setViewportSize({ width, height: 667 });
        await page.goto('/e2e/fixtures/route-meteogram.html');
        const dialog = page.getByRole('dialog', { name: 'Route report' });
        await expect(dialog).toBeVisible();
        await page.getByRole('button', { name: 'Route meteogram' }).click();
        await page.getByRole('button', { name: 'Use weather aboard' }).click();
        const report = page.getByTestId('route-meteogram');
        await expect(report).toBeVisible();
        await expect(report).toContainText('Loaded ICON wind grid');
        await expect(report).toContainText('2026-10-16 23:30:00 UTC');
        await expect(page.getByTestId('route-weather-credit')).toContainText('DWD (CC BY 4.0)');
        const slider = page.getByRole('slider', { name: 'Route weather hour' });
        await slider.focus();
        await slider.press('End');
        await expect(report).toContainText('0.0000°, 4.0000°');
        await page.getByText(/Hourly weather table/).click();
        const table = page.getByRole('table', { name: 'Route weather in UTC' });
        await expect(table).toContainText('Unknown');
        const issues = await dialog.evaluate((element) => {
            const result: string[] = [],
                box = element.getBoundingClientRect();
            if (box.left < 0 || box.right > innerWidth + 1 || box.top < 0 || box.bottom > innerHeight + 1)
                result.push('dialog leaves viewport');
            for (const e of [element, ...element.querySelectorAll<HTMLElement>('section, table, td')])
                if (e.scrollWidth > e.clientWidth + 1) result.push(`${e.tagName} overflows sideways`);
            return result;
        });
        expect(issues).toEqual([]);
        const close = dialog.getByRole('button', { name: 'Close', exact: true });
        await expect(close).toBeVisible();
        const path = info.outputPath(`route-weather-${width}.png`);
        await page.screenshot({ path, animations: 'disabled' });
        await info.attach('route weather fit', { path, contentType: 'image/png' });
        if (width === 300) {
            const download = page.waitForEvent('download');
            await dialog.getByRole('button', { name: /PDF/ }).click();
            const file = await download;
            const pdf = info.outputPath('route-weather.pdf');
            await file.saveAs(pdf);
            await info.attach('actual route weather PDF', { path: pdf, contentType: 'application/pdf' });
        }
        await close.click();
        await expect(dialog).toHaveCount(0);
        expect(weatherRequests).toEqual([]);
        expect(errors).toEqual([]);
    });
}
