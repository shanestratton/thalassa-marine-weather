import { test, expect } from '@playwright/test';
for (const width of [300, 375, 430])
    for (const scale of [100, 130])
        test(`one-row credits preserve map bounds at ${width}px ${scale}%`, async ({ page }, info) => {
            await page.setViewportSize({ width, height: 780 });
            const outbound: string[] = [];
            await page.route('**/*', (route) => {
                const u = new URL(route.request().url());
                if (['127.0.0.1', 'localhost'].includes(u.hostname) || u.protocol === 'blob:') return route.continue();
                if (u.hostname === 'api.mapbox.com' && u.pathname === '/map-sessions/v1')
                    return route.fulfill({ status: 200, body: '' });
                if (u.hostname === 'events.mapbox.com' && u.pathname === '/events/v2')
                    return route.fulfill({ status: 204, body: '' });
                outbound.push(u.origin);
                return route.abort();
            });
            await page.goto('/e2e/fixtures/obs-credits137.html');
            if (scale === 130) await page.addStyleTag({ content: 'html{font-size:130%}' });
            const row = page.getByTestId('obs-credits-rollup'),
                button = page.getByRole('button', { name: 'Credits', exact: true });
            await expect(page.locator('.mapboxgl-ctrl-attrib-button')).toBeVisible();
            await expect(page.locator('.mapboxgl-ctrl-logo')).toBeVisible();
            await expect(row).toBeVisible();
            const before = await page.evaluate(() => window.__creditsFixture.bounds()),
                box = await row.boundingBox();
            expect(box).not.toBeNull();
            expect(box!.width).toBeLessThanOrEqual(width - 16);
            expect(box!.height).toBe(44);
            const picker = await page.getByRole('button', { name: /^Map base:/ }).boundingBox();
            const mob = await page.getByRole('button', { name: /^MOB,/ }).boundingBox();
            expect(box!.y).toBeGreaterThanOrEqual(picker!.y + picker!.height + 5);
            expect(box!.x + box!.width).toBeLessThanOrEqual(mob!.x - 4);
            for (const target of [button, row.getByRole('link')]) {
                expect(
                    await target.evaluate((el) => {
                        const r = el.getBoundingClientRect();
                        return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
                    }),
                ).toBe(true);
            }

            expect(await row.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
            await page.evaluate(() => window.__creditsFixture.layers(1));
            await expect(button).toBeVisible();
            expect((await row.boundingBox())!.height).toBe(box!.height);
            await page.evaluate(() => window.__creditsFixture.layers(5));
            await button.click();
            const dialog = page.getByRole('dialog', { name: 'Map credits & source status' });
            await expect(dialog).toBeVisible();
            expect(await page.evaluate(() => window.__creditsFixture.bounds())).toEqual(before);
            expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
            await expect(dialog).toContainText('E.U. Copernicus Marine Service Information');
            await expect(dialog).toContainText('NOAA/NESDIS GMGSI');
            await expect(dialog).toContainText('AISHub contributors');
            const doi = dialog.getByRole('link', { name: /Global Ocean Physics/ });
            await doi.scrollIntoViewIfNeeded();
            await doi.click();
            expect(await page.evaluate(() => window.__creditLinks)).toEqual(['https://doi.org/10.48670/moi-00016']);
            await dialog.getByRole('button', { name: 'Play satellite loop' }).click();
            await expect(dialog.getByRole('button', { name: 'Pause satellite loop' })).toBeVisible();
            const rain = dialog.getByRole('link', { name: 'RainViewer', exact: true });
            await rain.click();
            expect(await page.evaluate(() => window.__creditLinks)).toContain('https://www.rainviewer.com/');
            await page.screenshot({ path: info.outputPath('credits-open.png') });
            await dialog.getByRole('button', { name: 'Close', exact: true }).click();
            await expect(dialog).toHaveCount(0);
            await page.screenshot({ path: info.outputPath('credits-closed.png') });
            await page.keyboard.press('h');
            await expect(page.getByTestId('credits-frame')).toHaveAttribute('data-obs-clear-view', 'on');
            await expect(row).toBeVisible();
            await button.click();
            await expect(dialog).toBeVisible();
            await dialog.getByRole('button', { name: 'Close', exact: true }).click();
            await expect(page.getByTestId('credits-frame')).toHaveAttribute('data-obs-clear-view', 'on');
            await page.keyboard.press('Escape');
            await expect(page.getByTestId('credits-frame')).toHaveAttribute('data-obs-clear-view', 'off');
            await page.getByRole('button', { name: 'Open layer menu', exact: true }).click();
            await expect(page.locator('[data-helm-scrim]')).toBeVisible();
            // The real scrim excludes the marked credit row; opening its sheet must remain reachable.
            await button.click();
            await expect(dialog).toBeVisible();
            await dialog.getByRole('button', { name: 'Close', exact: true }).click();
            await page.evaluate(() => window.__creditsFixture.warning());
            await expect(page.getByRole('button', { name: 'Credits; layer status needs review' })).toBeVisible();
            const warned = await row.boundingBox();
            expect(warned!.height).toBe(44);
            expect(warned!.x + warned!.width).toBeLessThanOrEqual(mob!.x - 4);
            expect(await row.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
            // Keep the full provider name and both usable targets when the warning adds its marker.
            for (const target of [
                page.getByRole('button', { name: 'Credits; layer status needs review' }),
                row.getByRole('link'),
            ]) {
                expect((await target.boundingBox())!.width).toBeGreaterThanOrEqual(44);
                expect(await target.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
                expect(
                    await target.evaluate((el) => {
                        const r = el.getBoundingClientRect();
                        return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
                    }),
                ).toBe(true);
            }

            expect(await page.evaluate(() => window.__creditsFixture.bounds())).toEqual(before);
            expect(outbound).toEqual([]);
        });
