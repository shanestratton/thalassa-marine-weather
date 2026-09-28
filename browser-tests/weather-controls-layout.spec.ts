import { expect, test, type Locator } from '@playwright/test';

async function reachable(control: Locator) {
    await control.scrollIntoViewIfNeeded();
    await expect
        .poll(() =>
            control.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                return (
                    rect.width >= 44 &&
                    rect.height >= 44 &&
                    rect.left >= 0 &&
                    rect.right <= innerWidth &&
                    rect.top >= 0 &&
                    rect.bottom <= innerHeight &&
                    (hit === element || element.contains(hit))
                );
            }),
        )
        .toBe(true);
}

for (const size of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 430, height: 932 },
    { width: 844, height: 390 },
]) {
    test(`weather layers retain one usable control surface at ${size.width} × ${size.height}`, async ({
        page,
        baseURL,
    }, info) => {
        const origin = new URL(baseURL!).origin;
        await page.route('**/*', (route) => {
            const request = route.request();
            const url = new URL(request.url());
            if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method())) return route.abort();
            if (url.pathname === '/components/map/cmemsFeatureAvailability.ts')
                return route.fulfill({
                    contentType: 'text/javascript',
                    body: 'export const isCmemsFeatureEnabled=()=>true;export const isWeatherLayerAvailable=()=>true;',
                });
            return route.continue();
        });
        await page.routeWebSocket('**/*', (socket) => socket.close());
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.setViewportSize(size);
        await page.goto('/e2e/fixtures/weather-controls.html');
        const panel = page.getByRole('region', { name: 'Weather controls', exact: true });
        await expect(panel).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        await reachable(page.getByRole('slider', { name: 'Wind timeline' }));
        await page.getByRole('slider', { name: 'Wind timeline' }).press('ArrowRight');
        await expect(page.getByRole('slider', { name: 'Wind timeline' })).toHaveAttribute('aria-valuenow', '1');
        for (const model of ['ICON', 'ECMWF', 'AIFS', 'UKMO', 'JMA']) {
            const choice = page.getByRole('button', { name: `Wind model ${model}` });
            await reachable(choice);
            await choice.click();
            await expect(choice).toHaveAttribute('aria-pressed', 'true');
        }
        for (const layer of ['Rain', 'Pressure', 'Air temperature', 'Clouds', 'Currents', 'Wind']) {
            const choice = page.getByRole('button', { name: `Control ${layer}`, exact: true });
            await reachable(choice);
            await choice.click();
            await expect(choice).toHaveAttribute('aria-pressed', 'true');
            if (['Wind', 'Rain', 'Currents'].includes(layer)) {
                const slider = page.getByRole('slider', { name: `${layer} timeline` });
                await expect(page.getByRole('slider')).toHaveCount(1);
                await reachable(slider);
                await slider.press('ArrowRight');
            } else {
                await expect(page.getByRole('slider')).toHaveCount(0);
            }
        }
        await page.getByRole('button', { name: 'Control Rain', exact: true }).click();
        if (size.width === 390)
            await page.screenshot({ path: info.outputPath('weather-controls-390.png'), animations: 'disabled' });
        await reachable(page.getByRole('button', { name: 'Show weather legends' }));
        await page.getByRole('button', { name: 'Show weather legends' }).click();
        for (const layer of ['Wind', 'Rain', 'Pressure', 'Air temperature', 'Clouds', 'Currents']) {
            const legend = page.getByRole('region', { name: `${layer} legend`, exact: true });
            await legend.scrollIntoViewIfNeeded();
            await expect(legend).toBeVisible();
        }
        expect(
            await panel.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                return (
                    rect.left >= 0 &&
                    rect.right <= innerWidth &&
                    rect.top >= 0 &&
                    rect.bottom <= innerHeight - 80 &&
                    element.scrollWidth <= element.clientWidth + 1 &&
                    document.documentElement.scrollWidth <= innerWidth
                );
            }),
        ).toBe(true);
        const hide = page.getByRole('button', { name: 'Hide weather controls' });
        await reachable(hide);
        await hide.click();
        await expect(panel).toHaveCount(0);
        const show = page.getByRole('button', { name: 'Show weather controls' });
        await reachable(show);
        await show.click();
        await expect(panel).toBeVisible();
        await expect(page.getByRole('link', { name: /Rain .* (RainViewer|Rainbow.ai)/ })).toBeVisible();
        expect(errors).toEqual([]);
    });
}
