import { test, expect } from '@playwright/test';
test.afterEach(async ({ page }, info) => {
    if (!page.isClosed())
        await info.attach('parent-native-source-events.json', {
            body: JSON.stringify(await page.evaluate(() => window.__satelliteParent141?.evidence()), null, 2),
            contentType: 'application/json',
        });
});
for (const width of [300, 375])
    test(`actual shared satellite parent controls at${width}px130%text`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 780 });
        await page.clock.setFixedTime(new Date('2026-10-17T03:30:00Z'));
        const errors: string[] = [],
            outbound: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (['127.0.0.1', 'localhost'].includes(url.hostname) || ['data:', 'blob:'].includes(url.protocol))
                return route.continue();
            outbound.push(url.origin);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/satelliteParent141.html');
        await page.addStyleTag({ content: 'html{font-size:130%}' });
        const evidence = () =>
            page.evaluate(() => window.__satelliteParent141.evidence()) as Promise<{
                selection: { sharper: boolean; hourly: boolean; hourlyStatus: string };
                layers: string[];
                requests: string[];
                errors: string[];
                remote: string[];
                canvas: { width: number; height: number };
                scrollWidth: number;
                scrollHeight: number;
            }>;
        const extent = async () => {
            const e = await evidence();
            expect(e.canvas).toEqual({ width, height: 780 });
            expect([e.scrollWidth, e.scrollHeight]).toEqual([width, 780]);
            expect(e.remote).toEqual([]);
            expect(e.errors).toEqual([]);
        };
        const openSky = async () => {
            await page.getByRole('button', { name: 'Open layer menu' }).click();
            await page.getByRole('menuitem', { name: 'Sky layers' }).click();
        };
        await openSky();
        expect((await evidence()).requests).toEqual([]);
        await expect(page.getByRole('menuitemcheckbox', { name: 'Sharper sat, off' })).toHaveCount(1);
        await page.getByRole('menuitemcheckbox', { name: 'Sharper sat, off' }).click();
        await expect(page.getByRole('menuitem', { name: 'Clear all · 1 active' })).toHaveCount(1);
        await page.getByRole('button', { name: 'Close layer menu' }).click();
        await page.getByRole('button', { name: 'Show layer key' }).click();
        const panel = page.getByRole('region', { name: 'Sharper satellite controls' }),
            status = panel.getByRole('status');
        await expect(status).toContainText('Listed frame', { timeout: 30000 });
        await extent();
        const credits = page.getByTestId('obs-credits-rollup');
        expect((await credits.boundingBox())!.height).toBe(44);
        await page.screenshot({ path: info.outputPath('sharper-parent-key.png') });

        // A metadata-listed real decoded PNG with zero alpha cannot acquire a native image owner or Ready label.
        await page.evaluate(() => window.__satelliteParent141.blank(true));
        await panel.getByRole('button', { name: 'Retry', exact: true }).click();
        await expect(status).toContainText('Satellite image unavailable');
        expect((await evidence()).layers).toEqual([]);
        await credits.getByRole('button').click();
        const dialog = page.getByRole('dialog', { name: 'Map credits & source status' });
        await expect(dialog).toContainText('gaps and missing coverage are unknown');
        await expect(dialog).toContainText('Satellite image unavailable');
        await extent();
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await page.evaluate(() => window.__satelliteParent141.blank(false));
        await page.evaluate(() => window.__satelliteParent141.uniform(true));
        await panel.getByRole('button', { name: 'Retry', exact: true }).click();
        await expect(status).toContainText('Satellite image unavailable');
        expect((await evidence()).layers).toEqual([]);
        await page.evaluate(() => window.__satelliteParent141.uniform(false));
        await panel.getByRole('button', { name: 'Retry', exact: true }).click();
        await expect(status).toContainText('Listed frame');

        await panel.getByRole('button', { name: 'Hourly mosaic', exact: true }).click();
        await expect(panel).toHaveCount(0);
        await expect.poll(async () => (await evidence()).selection.hourlyStatus, { timeout: 30000 }).toBe('ready');
        expect((await evidence()).layers).toEqual(['sat-ir-layer']);
        expect((await evidence()).selection).toMatchObject({ sharper: false, hourly: true });
        await openSky();
        await expect(page.getByRole('menuitemcheckbox', { name: 'Sat cloud, on' })).toHaveCount(1);
        await page.getByRole('menuitemcheckbox', { name: 'Sharper sat, off' }).click();
        await page.getByRole('button', { name: 'Close layer menu' }).click();
        await expect(status).toContainText('Listed frame');
        expect((await evidence()).layers).toEqual(['sharper-satellite-view-layer']);
        expect((await evidence()).selection).toMatchObject({ sharper: true, hourly: false });

        await page.evaluate(() => window.__satelliteParent141.satMode(true));
        await expect(status).toContainText('paused in Satellite Mode');
        const paused = (await evidence()).requests.length;
        await expect.poll(async () => (await evidence()).layers).toEqual([]);
        expect((await evidence()).requests).toHaveLength(paused);
        await page.evaluate(() => window.__satelliteParent141.satMode(false));
        await expect(status).toContainText('Listed frame');
        await extent();

        await page.evaluate(() => window.__satelliteParent141.delay());
        await panel.getByRole('slider').press('Home');
        await expect(status).toContainText('Loading');
        await openSky();
        await page.getByRole('menuitem', { name: 'Clear all · 1 active' }).click();
        await page.evaluate(() => window.__satelliteParent141.resolve());
        await expect(panel).toHaveCount(0);
        await expect.poll(async () => (await evidence()).layers).toEqual([]);
        expect((await evidence()).selection).toMatchObject({ sharper: false, hourly: false });
        await extent();
        expect(errors).toEqual([]);
        expect(outbound).toEqual([]);
    });
