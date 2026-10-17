import { expect, test } from '@playwright/test';
interface Proof {
    render: () => Promise<{ cyan: number; radar: number; ais: number; drawn: unknown }>;
    age: () => void;
    retire: () => void;
}
for (const width of [300, 375])
    test(`generated radar map, proven association and Targets fit ${width}px`, async ({ page }, info) => {
        test.setTimeout(60000);
        await page.setViewportSize({ width, height: 667 });
        const external: { url: string; body: string }[] = [];
        page.on('pageerror', (error) => console.error('Radar fixture:', error.message));
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol === 'blob:') return route.continue();
            external.push({ url: url.href, body: route.request().postData() ?? '' });
            return route.abort();
        });
        // Keep generated sensor clocks fixed while each real renderer loads; timers still run.
        await page.clock.setFixedTime(new Date('2026-01-02T12:00:00Z'));
        await page.goto('/e2e/fixtures/radar137.html');
        await page.addStyleTag({ content: 'html{font-size:130%}' });
        await expect(page.getByRole('status', { exact: true })).toHaveText('Map ready');
        const proof = () => page.evaluate(() => (window as unknown as { __radar137: Proof }).__radar137.render());
        await expect
            .poll(
                async () => {
                    const p = await proof();
                    return p.radar === 2 && p.ais === 0 && p.cyan > 5;
                },
                { timeout: 20000 },
            )
            .toBe(true);
        const result = await proof();
        expect(JSON.stringify(result.drawn)).toContain('AIS + radar Generated matched vessel');
        await page.screenshot({ path: info.outputPath('radar-map.png') });
        await page.getByRole('button', { name: 'Open targets' }).click();
        const sheet = page.getByRole('dialog', { name: 'AIS targets', exact: true });
        await expect(sheet.getByText('Targets · 2')).toBeVisible();
        await expect(sheet.getByRole('button', { name: /AIS \+ radar · Generated matched vessel/ })).toHaveCount(1);
        const rangeOnly = sheet.getByRole('button', { name: /Radar · <img src=x>/ });
        await expect(rangeOnly).toContainText('ground motion unknown');
        expect(await sheet.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        await rangeOnly.click();
        await expect(sheet).toHaveCount(0);
        await expect(page.locator('.mapboxgl-popup')).toContainText('CPA unknown · range only');
        expect(await page.locator('.mapboxgl-popup img').count()).toBe(0);
        await page.clock.setFixedTime(new Date('2026-01-02T12:00:16Z'));
        await page.evaluate(() => (window as unknown as { __radar137: Proof }).__radar137.age());
        await expect(page.locator('.mapboxgl-popup')).toContainText('stale');
        await page.evaluate(() => (window as unknown as { __radar137: Proof }).__radar137.retire());
        await expect(page.locator('.mapboxgl-popup')).toHaveCount(0);
        await page.getByRole('button', { name: 'Open targets' }).click();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('button', { name: 'Open targets' })).toBeFocused();
        // All WAN was blocked. The map SDK may attempt only its fixed synthetic-token
        // license/metrics endpoints; radar facts never enter those requests.
        for (const request of external) {
            const url = new URL(request.url);
            expect(
                (url.hostname === 'events.mapbox.com' && url.pathname === '/events/v2') ||
                    (url.hostname === 'api.mapbox.com' && url.pathname === '/map-sessions/v1'),
            ).toBe(true);
            expect(request.body).not.toMatch(/radar:|RATTM|RATLL|123456789|Generated matched|<img/);
        }
        await info.attach('radar-frame.json', { body: JSON.stringify(result), contentType: 'application/json' });
    });
