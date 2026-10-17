import { test, expect } from '@playwright/test';
for (const width of [300, 375, 430])
    for (const scale of [100, 130]) {
        test(`140 separate Pi consent fits and stops with one tap at${width}/${scale}`, async ({ page }, info) => {
            await page.setViewportSize({ width, height: 780 });
            await page.route('**/*', (route) => {
                const u = new URL(route.request().url());
                return ['127.0.0.1', 'localhost'].includes(u.hostname) || u.protocol === 'blob:'
                    ? route.continue()
                    : route.abort();
            });
            await page.goto('/e2e/fixtures/receiver-coverage140.html?view=phone');
            if (scale === 130) await page.addStyleTag({ content: 'html{font-size:130%}' });
            const dialog = page.getByRole('dialog', { name: 'Pi AIS sharing' });
            await expect(dialog).toBeVisible();
            const enable = page.getByRole('button', { name: 'Enable for this vessel' }),
                stop = page.getByRole('button', { name: 'Stop Pi sharing' });
            await expect(enable).toBeDisabled();
            await expect(dialog).toContainText('publicly trackable');
            await page.screenshot({ path: info.outputPath(`pi-review-${width}-${scale}.png`) });
            expect(
                await page.evaluate(
                    () =>
                        document.documentElement.scrollWidth <= innerWidth &&
                        document.documentElement.scrollHeight <= innerHeight,
                ),
            ).toBe(true);
            for (const target of [stop, page.getByRole('button', { name: 'Close' })]) {
                await target.scrollIntoViewIfNeeded();
                const box = await target.boundingBox();
                expect(box!.height).toBeGreaterThanOrEqual(44);
                expect(
                    await target.evaluate((el) => {
                        const r = el.getBoundingClientRect();
                        return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
                    }),
                ).toBe(true);
            }
            await page.getByRole('checkbox').check();
            await expect(enable).toBeEnabled();
            await stop.click();
            await expect(dialog).toContainText('Cloud withdrawal could not be confirmed');
            expect(await page.evaluate(() => window.__receiverFixture.actions)).toEqual(['off']);
            await page.screenshot({ path: info.outputPath(`pi-${width}-${scale}.png`) });
        });
        test(`140 receiver menu and existing credit rollup preserve map extent at${width}/${scale}`, async ({
            page,
        }, info) => {
            await page.setViewportSize({ width, height: 780 });
            const external: string[] = [];
            await page.route('**/*', (route) => {
                const u = new URL(route.request().url());
                if (['127.0.0.1', 'localhost'].includes(u.hostname) || u.protocol === 'blob:') return route.continue();
                if (u.hostname === 'api.mapbox.com' && u.pathname === '/map-sessions/v1')
                    return route.fulfill({ status: 200, body: '' });
                if (u.hostname === 'events.mapbox.com' && u.pathname === '/events/v2')
                    return route.fulfill({ status: 204, body: '' });
                external.push(u.origin);
                return route.abort();
            });
            await page.goto('/e2e/fixtures/receiver-coverage140.html');
            if (scale === 130) await page.addStyleTag({ content: 'html{font-size:130%}' });
            await expect(page.locator('.mapboxgl-ctrl-logo')).toBeVisible();
            const before = await page.evaluate(() => window.__receiverFixture.bounds());
            await page.getByRole('button', { name: 'Open layer menu', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Live layers', exact: true }).click();
            const toggle = page.getByRole('menuitemcheckbox', { name: 'Who’s listening, off', exact: true });
            await expect(toggle).toBeVisible();
            await expect
                .poll(async () => (await toggle.boundingBox())?.height ?? 0, { timeout: 3000 })
                .toBeGreaterThanOrEqual(44);
            const box = await toggle.boundingBox();
            expect(box!.height).toBeGreaterThanOrEqual(44);
            await toggle.click();
            await page.getByRole('button', { name: 'Close layer menu', exact: true }).click();
            await expect(page.getByRole('menu')).toBeHidden();
            await expect(page.locator('.radial-helm-layer-grid')).toHaveCount(0);
            await expect(page.locator('[data-helm-scrim]')).toHaveCount(0);
            const row = page.getByTestId('obs-credits-rollup');
            await expect(row).toBeVisible();
            expect((await row.boundingBox())!.height).toBe(44);
            expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
            await page.screenshot({ path: info.outputPath(`coverage-map-${width}-${scale}.png`) });
            await page.getByRole('button', { name: /^Credits/ }).click();
            await expect(page.getByRole('dialog')).toContainText('Sign in to view coarse receiver coverage');
            expect(await page.evaluate(() => window.__receiverFixture.bounds())).toEqual(before);
            expect(external.filter((url) => !url.includes('sentry'))).toEqual([]);
            await page.screenshot({ path: info.outputPath(`coverage-${width}-${scale}.png`) });
        });
    }
