import { expect, test, type Locator } from '@playwright/test';

async function touchTarget(control: Locator) {
    await control.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await expect
        .poll(() =>
            control.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                const pseudo = getComputedStyle(element, '::before');
                const width = Math.max(rect.width, parseFloat(pseudo.width) || 0);
                const height = Math.max(rect.height, parseFloat(pseudo.height) || 0);
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;
                return (
                    width >= 44 &&
                    height >= 44 &&
                    [
                        [0, 0],
                        [-20, 0],
                        [20, 0],
                        [0, -20],
                        [0, 20],
                    ].every(([dx, dy]) => {
                        const hit = document.elementFromPoint(x + dx, y + dy);
                        return hit === element || element.contains(hit);
                    })
                );
            }),
        )
        .toBe(true);
}

for (const width of [320, 390]) {
    for (const mode of ['only', 'combined']) {
        test(`integrated chart key ${mode} remains usable at ${width}px`, async ({ page, baseURL }, info) => {
            test.skip(info.project.name !== 'webkit', 'Focused iPhone integration check');
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
            await page.setViewportSize({ width, height: 844 });
            await page.goto(`/e2e/fixtures/weather-controls.html?extras=${mode}`);
            const panel = page.getByRole('region', { name: 'Chart layer controls', exact: true });
            await expect(panel).toBeVisible();
            await expect(page.getByRole('slider')).toHaveCount(mode === 'combined' ? 1 : 0);
            await page.getByRole('button', { name: 'Show layer key' }).click();
            const guard = page.getByRole('button', { name: 'Enable AIS guard zone' });
            await touchTarget(guard);
            await guard.click();
            // Build 125 (125-01): the shield arms the collision alarm too, so it
            // arms only through the real sound check (play, stop, confirm heard).
            const check = page.getByRole('dialog', { name: 'Sound check' });
            await expect(check).toBeVisible();
            await check.getByRole('button', { name: 'Play test alarm' }).click();
            await check.getByRole('button', { name: 'Stop test alarm' }).click();
            await check.getByRole('button', { name: 'Confirm alarm was audible' }).click();
            await check.getByRole('button', { name: 'Confirm selection' }).click();
            await expect(check).toHaveCount(0);
            await expect(page.getByRole('button', { name: 'Disable AIS guard zone' })).toHaveAttribute(
                'aria-pressed',
                'true',
            );
            const radiusPicker = page.getByRole('button', { name: 'Choose AIS guard zone radius' });
            await touchTarget(radiusPicker);
            await radiusPicker.click();
            const radius = page.getByRole('button', { name: 'Set AIS guard zone radius to 5 nautical miles' });
            await touchTarget(radius);
            await radius.click();
            await expect(page.getByRole('button', { name: 'Disable AIS guard zone' })).toContainText('5 NM');
            const filter = page.getByRole('combobox', { name: 'Buoy body colour' });
            await touchTarget(filter);
            expect(await filter.evaluate((element) => getComputedStyle(element).backgroundImage)).toContain(
                'data:image/svg+xml',
            );
            await filter.selectOption('blue');
            await expect(filter).toHaveValue('blue');
            await expect(page.getByText('Other colours and unknown-colour moorings are hidden.')).toBeVisible();
            for (const name of [
                'AIS key',
                'Lightning key',
                'Squalls key',
                'Storms key',
                'Tide stations key',
                'Moorings and anchorages key',
                'Routes & tracks key',
                'Sea marks key',
                'Protected areas key',
            ]) {
                const key = page.getByRole('region', { name, exact: true });
                await key.scrollIntoViewIfNeeded();
                await expect(key).toBeVisible();
                expect(await key.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), name).toBe(
                    true,
                );
            }
            await expect(page.getByText('3 nearby stations loaded.')).toBeVisible();
            await expect(page.getByText('Unverified route')).toBeVisible();
            expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            const hide = page.getByRole('button', { name: 'Hide layer controls' });
            await touchTarget(hide);
            await hide.click();
            await expect(panel).toHaveCount(0);
            const reopen = page.getByRole('button', { name: 'Show layer controls' });
            await touchTarget(reopen);
            await reopen.click();
            await page.getByRole('button', { name: 'Start look-ahead' }).click();
            await expect(panel).toBeVisible();
            await expect(page.getByRole('slider')).toHaveCount(0);
            await expect(page.getByRole('group', { name: 'Wind forecast model' })).toHaveCount(0);
            await expect(page.getByRole('group', { name: 'Weather layer controls' })).toHaveCount(0);
            await page.getByRole('button', { name: 'Show layer key' }).click();
            await expect(page.getByRole('button', { name: 'Disable AIS guard zone' })).toHaveAttribute(
                'aria-pressed',
                'true',
            );
            await expect(filter).toHaveValue('blue');
            await filter.scrollIntoViewIfNeeded();
            if (width === 390)
                await page.screenshot({ path: info.outputPath(`obs-key-${mode}-390.png`), animations: 'disabled' });
            await touchTarget(hide);
            await hide.click();
            await touchTarget(reopen);
            await reopen.click();
            await expect(page.getByRole('button', { name: 'Show layer key' })).toBeVisible();
            await expect(page.getByRole('slider')).toHaveCount(0);
            await page.getByRole('button', { name: 'End look-ahead' }).click();
            await expect(page.getByRole('slider')).toHaveCount(mode === 'combined' ? 1 : 0);
            expect(errors).toEqual([]);
        });
    }
}
