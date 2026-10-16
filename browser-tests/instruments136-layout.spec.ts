import { test, expect } from '@playwright/test';
for (const width of [300, 375]) {
    test(`real instrument panel at ${width}px preserves visibility and sailing state`, async ({ page }) => {
        await page.setViewportSize({ width, height: 667 });
        const remote: string[] = [];
        await page.route('**/*', (route) => {
            const u = new URL(route.request().url());
            if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.protocol === 'blob:')
                return route.continue();
            remote.push(u.hostname);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/instruments136.html');
        await expect(page.getByText('Instrument Panel', { exact: true })).toBeVisible();
        await expect
            .poll(() =>
                page
                    .locator('section')
                    .evaluateAll((nodes) =>
                        nodes.map((node) => node.querySelector('h2')?.textContent?.split(' ·')[0]).filter(Boolean),
                    ),
            )
            .toEqual(['Clock', 'Wind', 'Position', 'Speed', 'Performance', 'Current', 'Depth', 'Sea temp', 'Heading']);
        const perf = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Performance ·/ }) });
        await perf.scrollIntoViewIfNeeded();
        await expect(perf.getByRole('button', { name: 'Under sail', exact: true })).toBeVisible();
        await page.screenshot({ path: test.info().outputPath('instrument-performance.png') });
        await perf.getByRole('button', { name: 'Under sail', exact: true }).click();
        await expect(perf.getByRole('button', { name: 'Under sail confirmed · clear' })).toBeVisible();
        const current = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Current ·/ }) });
        await current.scrollIntoViewIfNeeded();
        await expect(current.getByText('Set 090°T')).toBeVisible();
        await page.screenshot({ path: test.info().outputPath('instrument-current.png') });
        for (const section of [perf, current]) {
            const box = await section.boundingBox();
            expect(box).not.toBeNull();
            expect(await section.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        }
        await page.getByRole('button', { name: 'Preferences', exact: true }).click();
        const toggle = page.getByRole('switch', { name: 'Show Current' });
        await toggle.scrollIntoViewIfNeeded();
        await toggle.click();
        await page.getByRole('button', { name: 'Preferences', exact: true }).click();
        await expect(page.getByRole('heading', { name: /^Current ·/ })).toHaveCount(0);
        await page.evaluate(() => {
            const p = (window as unknown as { __instruments136: { mode: (v: string) => void } }).__instruments136;
            p.mode('legacy');
        });
        await expect(page.getByRole('heading', { name: /^Performance ·/ })).toHaveCount(0);
        await expect(page.getByRole('heading', { name: /^Speed ·/ })).toHaveCount(1);
        await page.evaluate(() => {
            (window as unknown as { __instruments136: { mode: (v: string) => void } }).__instruments136.mode('empty');
        });
        await expect.poll(() => page.locator('section').count()).toBe(1);
        await expect(page.getByRole('heading', { name: /^Clock ·/ })).toHaveCount(1);
        expect(remote).toEqual([]);
        await page.screenshot({ path: test.info().outputPath('instrument-clock.png') });
    });

    test(`real instrument overlay at ${width}px draws and retires local guides`, async ({ page }) => {
        await page.setViewportSize({ width, height: 667 });
        const remote: string[] = [];
        await page.route('**/*', (route) => {
            const u = new URL(route.request().url());
            if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.protocol === 'blob:')
                return route.continue();
            if (u.hostname === 'events.mapbox.com')
                return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
            if (u.hostname === 'api.mapbox.com' && u.pathname.includes('/map-sessions/'))
                return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
            remote.push(u.hostname);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/instruments136-map.html');
        await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
        await expect(page.getByText(/Instrument current 1.0 kn/)).toBeVisible();
        const probe = () =>
            page.evaluate(() =>
                (
                    window as unknown as {
                        __instrumentMap: {
                            probe: () => {
                                own: boolean;
                                model: boolean;
                                features: { features: unknown[] };
                                angle: string;
                            };
                        };
                    }
                ).__instrumentMap.probe(),
            );
        await expect
            .poll(async () => {
                const p = await probe();
                return [p.own, p.model, p.features?.features.length];
            })
            .toEqual([true, true, 2]);
        expect((await probe()).angle).toContain('rotate(60');
        await page.screenshot({ path: test.info().outputPath('instrument-current-laylines.png') });
        await page.evaluate(() =>
            (window as unknown as { __instrumentMap: { clear: () => void } }).__instrumentMap.clear(),
        );
        await expect(page.getByText(/Instrument current/)).toHaveCount(0);
        await expect
            .poll(async () => {
                const p = await probe();
                return [p.own, p.model];
            })
            .toEqual([false, true]);
        expect(remote).toEqual([]);
    });
}
