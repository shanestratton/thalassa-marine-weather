import { test, expect } from '@playwright/test';
test.afterEach(async ({ page }, info) => {
    if (!page.isClosed())
        await info.attach('all-outcomes-source-events.json', {
            body: JSON.stringify(await page.evaluate(() => window.__satellite141?.evidence()), null, 2),
            contentType: 'application/json',
        });
});
for (const width of [300, 375])
    test(`bounded sharper satellite at ${width}px and130%text`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 780 });
        await page.clock.setFixedTime(new Date('2026-10-17T03:30:00Z'));
        const errors: string[] = [],
            remote: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (['127.0.0.1', 'localhost'].includes(url.hostname) || ['data:', 'blob:'].includes(url.protocol))
                return route.continue();
            remote.push(url.origin);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/satellite141.html');
        await page.addStyleTag({ content: 'html{font-size:130%}' });
        await page.getByRole('button', { name: 'Show layer key' }).click();
        const panel = page.getByRole('region', { name: 'Sharper satellite controls' }),
            status = panel.getByRole('status');
        await expect(status).toContainText('Listed frame 2026-10-17 03:30:00 UTC', { timeout: 30000 });
        const extent = async () => {
            const evidence = (await page.evaluate(() => window.__satellite141.evidence())) as {
                canvas: { width: number; height: number };
                scrollWidth: number;
                scrollHeight: number;
                remote: string[];
                errors: string[];
            };
            expect(evidence.canvas).toEqual({ width, height: 780 });
            expect(evidence.scrollWidth).toBe(width);
            expect(evidence.scrollHeight).toBe(780);
            expect(evidence.remote).toEqual([]);
            expect(evidence.errors).toEqual([]);
            expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        };
        await extent();
        await page.screenshot({ path: info.outputPath('satellite-source-and-time.png') });
        await panel.getByRole('button', { name: 'Info', exact: true }).click();
        await expect(panel).toContainText('not surface fog or visibility');
        const detail = panel.locator('p').filter({ hasText: 'Upper water vapour is mid/upper-air moisture' });
        await detail.scrollIntoViewIfNeeded();
        expect(
            await detail.evaluate((node) => {
                const r = node.getBoundingClientRect(),
                    hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return !!hit && (node === hit || node.contains(hit));
            }),
        ).toBe(true);
        await extent();
        await page.screenshot({ path: info.outputPath('satellite-controls.png') });
        const credits = page.getByTestId('obs-credits-rollup');
        expect((await credits.boundingBox())!.height).toBe(44);
        await credits.getByRole('button').click();
        const dialog = page.getByRole('dialog', { name: 'Map credits & source status' });
        await expect(dialog).toContainText('JMA Himawari-9');
        await expect(dialog).toContainText('image acquisition clock not embedded');
        await extent();
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await panel.getByRole('combobox').selectOption('meteosat-ir');
        await expect(status).toContainText('Listed frame 2026-10-17 03:00:00 UTC');
        const evidence = (await page.evaluate(() => window.__satellite141.evidence())) as { upstream: string[] };
        for (const url of evidence.upstream.filter(
            (value) => value.includes('view.eumetsat.int') && value.includes('GetMap'),
        ))
            expect(new URL(url).searchParams.get('time')).toMatch(/T\d{2}:00:00Z$/);
        await panel.getByRole('combobox').selectOption('viirs-night');
        await expect(status).toContainText('2026-10-17 · daily night composite');
        await extent();
        await panel.getByRole('combobox').selectOption('water-vapour');
        await expect(status).toContainText('Listed frame');
        await expect(panel).toContainText('mid/upper-air moisture');
        await panel.getByRole('combobox').selectOption('himawari-ir');
        await expect(status).toContainText('Listed frame');
        await page.evaluate(() => window.__satellite141.dateline());
        await expect
            .poll(async () => {
                const value = (await page.evaluate(() => window.__satellite141.evidence())) as { requests: string[] };
                return value.requests
                    .filter((url) => url.includes('action=image'))
                    .some((url) => new URL(url, 'https://local.test').searchParams.get('bbox')?.startsWith('-180,'));
            })
            .toBe(true);
        await expect(status).toContainText('Listed frame');
        await page.evaluate(() => window.__satellite141.delay());
        await panel.getByRole('slider').press('Home');
        await expect(status).toContainText('Loading');
        await page.evaluate(() => {
            window.__satellite141.off();
            window.__satellite141.resolve();
        });
        await expect(panel).toHaveCount(0);
        await expect
            .poll(async () => {
                const value = (await page.evaluate(() => window.__satellite141.evidence())) as { layers: string[] };
                return value.layers;
            })
            .toEqual([]);
        expect(errors).toEqual([]);
        expect(remote).toEqual([]);
        await info.attach('source-lifetime-extent.json', {
            body: JSON.stringify(await page.evaluate(() => window.__satellite141.evidence()), null, 2),
            contentType: 'application/json',
        });
    });
