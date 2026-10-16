import { expect, test } from '@playwright/test';
for (const width of [300, 375])
    test(`Local route references and RAM retirement fit ${width}px at 130% text`, async ({ page }) => {
        await page.setViewportSize({ width, height: 812 });
        const remote: string[] = [];
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol === 'blob:') return route.continue();
            remote.push(url.hostname);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/along-route138.html');
        await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
        const modalGeometry = await page.getByRole('dialog', { name: 'Route report' }).evaluate((node) => {
            const title = node.querySelector('#trace-report-title')!.parentElement!;
            const header = title.parentElement!;
            const actions = header.lastElementChild as HTMLElement;
            const classes = [header.className, title.className, actions.className];
            const bounds = () => {
                const r = node.getBoundingClientRect();
                return [r.x, r.y, r.width, r.height];
            };
            const after = bounds();
            // The exact three original header classes from parent 331837b.
            // Temporarily restore them to compare the original outer extent.
            header.className = 'flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-4 py-3';
            title.className = 'min-w-0';
            actions.className = 'flex shrink-0 items-center gap-3';
            const before = bounds();
            [header.className, title.className, actions.className] = classes;
            return { before, after, viewport: [innerWidth, innerHeight] };
        });
        expect(modalGeometry.after).toEqual(modalGeometry.before);
        expect(modalGeometry.after[3]).toBeLessThanOrEqual(modalGeometry.viewport[1] * 0.85 + 1);
        await test
            .info()
            .attach('modal-geometry', { body: JSON.stringify(modalGeometry), contentType: 'application/json' });
        const title = await page.getByRole('heading', { name: 'Route report', exact: true }).boundingBox();
        const gpx = await page.getByRole('button', { name: '⬇ GPX', exact: true }).boundingBox();
        expect(title && gpx && (title.y + title.height <= gpx.y || title.x + title.width <= gpx.x)).toBe(true);
        await page.getByRole('button', { name: 'Along the route', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Download public references' })).toBeDisabled();
        await expect(page.getByTestId('along-route-results')).toHaveCount(0);
        await page.getByRole('button', { name: 'Use references aboard' }).click();
        await expect(page.getByTestId('along-route-results')).toBeVisible();
        await expect(page.getByTestId('along-route-results')).toContainText('3 references');
        await expect(page.getByTestId('along-route-results')).toContainText('Entirely fictional chart bridge');
        await expect(page.getByTestId('along-route-results')).toContainText('Chart summary · aboard RAM only');
        await expect(page.getByTestId('along-route-results')).toContainText('gust —');
        expect(
            await page.getByTestId('along-route-results').evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
        ).toBe(true);
        expect(await page.locator('body').evaluate((node) => node.scrollWidth <= window.innerWidth + 1)).toBe(true);
        await page.getByTestId('along-route-results').scrollIntoViewIfNeeded();
        await page.screenshot({ path: test.info().outputPath('along-route-report.png') });
        const report = await page.evaluate(() =>
            (
                window as unknown as {
                    __along138: {
                        report: () => {
                            rows: { kind: string; sourceUrl: string | null; weather: { windKts: number | null } }[];
                        };
                    };
                }
            ).__along138.report(),
        );
        expect(report.rows.find((row) => row.kind === 'bridge')?.sourceUrl).toBeNull();
        expect(report.rows.every((row) => row.weather.windKts !== null)).toBe(true);
        expect(
            await page.evaluate(() =>
                (window as unknown as { __along138: { localText: () => string } }).__along138.localText(),
            ),
        ).not.toContain('Entirely fictional chart bridge');
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(page.getByTestId('along-route-next-up')).toContainText('Fictional anchorage');
        await page.screenshot({ path: test.info().outputPath('along-route-next-up.png') });
        await page.evaluate(() =>
            (window as unknown as { __along138: { changeCharts: () => void } }).__along138.changeCharts(),
        );
        await expect(page.getByTestId('along-route-next-up')).toHaveCount(0);
        expect(
            await page.evaluate(() =>
                (window as unknown as { __along138: { report: () => unknown } }).__along138.report(),
            ),
        ).toBeNull();
        expect(
            await page.evaluate(() =>
                (window as unknown as { __along138: { remote: () => number } }).__along138.remote(),
            ),
        ).toBe(0);
        expect(remote).toEqual([]);
    });
