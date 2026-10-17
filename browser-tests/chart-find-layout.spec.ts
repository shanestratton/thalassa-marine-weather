import { expect, test } from '@playwright/test';
for (const width of [300, 375])
    test(`local chart find ${width}px130%: light character, dateline fly, bounded layout and retirement`, async ({
        page,
    }, testInfo) => {
        await page.setViewportSize({ width, height: 667 });
        const unexpected: string[] = [];
        await page.route('**/*', (route) => {
            const u = new URL(route.request().url());
            if (['localhost', '127.0.0.1'].includes(u.hostname) || ['blob:', 'data:'].includes(u.protocol))
                return route.continue();
            // The actual Mapbox camera starts its own SDK handshake/telemetry.
            // Block those fixed SDK endpoints too; none may carry a search term.
            if (
                (u.hostname === 'events.mapbox.com' && u.pathname === '/events/v2') ||
                (u.hostname === 'api.mapbox.com' && u.pathname === '/map-sessions/v1')
            ) {
                expect(route.request().postData() ?? '').not.toMatch(/Fictional|PRIVATE|Fl\.G/);
                return route.abort();
            }
            unexpected.push(u.origin + u.pathname);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/chart-find.html');
        await page.evaluate(() => (document.documentElement.style.fontSize = '130%'));
        const open = page.getByRole('button', { name: 'Charts & detail', exact: true });
        await expect(open).toBeEnabled();
        await open.click();
        const entry = page.getByRole('button', { name: 'Find on chart · lights, marks, places' });
        await entry.click();
        const sheet = page.getByRole('dialog', { name: 'Find on chart', exact: true });
        await expect(sheet).toBeVisible();
        await sheet.getByRole('button', { name: 'Read NOAA agreement' }).click();
        const agreement = page.getByRole('dialog', { name: 'NOAA chart agreement' });
        await agreement.getByRole('checkbox').check();
        await agreement.getByRole('button', { name: 'Accept NOAA agreement' }).click();
        await expect(agreement).toHaveCount(0);
        await sheet.getByRole('button', { name: 'Read downloaded NOAA around view' }).click();
        await expect(sheet.getByRole('status')).toContainText('1 downloaded cell read.');
        const search = sheet.getByRole('searchbox');
        await search.fill('Fl.G 3.0s');
        await expect(sheet.getByRole('button', { name: /Fictional green entrance light/ })).toBeVisible();
        await expect(sheet.getByText('FlG 3s', { exact: true })).toBeVisible();
        const dimensions = await sheet.evaluate((el) => {
            const b = el.getBoundingClientRect();
            return {
                left: b.left,
                right: b.right,
                top: b.top,
                bottom: b.bottom,
                width: el.scrollWidth,
                client: el.clientWidth,
            };
        });
        expect(dimensions.left).toBeGreaterThanOrEqual(0);
        expect(dimensions.right).toBeLessThanOrEqual(width);
        expect(dimensions.top).toBeGreaterThanOrEqual(0);
        expect(dimensions.bottom).toBeLessThanOrEqual(667);
        expect(dimensions.width).toBeLessThanOrEqual(dimensions.client);
        await page.screenshot({ path: testInfo.outputPath(`find-${width}.png`) });
        await search.fill('PRIVATE');
        await expect(sheet.getByText(/No match in the available chart portions/)).toBeVisible();
        await expect(sheet.getByRole('button', { name: /PRIVATE LICENSED BAY/ })).toHaveCount(0);
        await search.fill('dateline');
        const bay = sheet.getByRole('button', { name: /Fictional Dateline Bay/ });
        await expect(bay).toBeVisible();
        await bay.click();
        await expect(sheet).toHaveCount(0);
        await expect
            .poll(() =>
                page.evaluate(() => {
                    const m = (
                        window as unknown as {
                            __chartFindMap: { getCenter: () => { lng: number; lat: number }; getZoom: () => number };
                        }
                    ).__chartFindMap;
                    return {
                        lon: Math.abs(Math.abs(m.getCenter().lng) - 180),
                        // Mercator round trip differs by ~3e-14 degrees.
                        lat: Number(m.getCenter().lat.toFixed(8)),
                        zoom: m.getZoom(),
                    };
                }),
            )
            .toEqual({ lon: 0, lat: -27, zoom: 14 });
        await open.click();
        await entry.click();
        await sheet.getByRole('searchbox').fill('port');
        await expect(sheet.getByRole('button', { name: /Fictional port mark/ })).toBeVisible();
        await page.evaluate(() => (window as unknown as { __chartFindRemove: () => void }).__chartFindRemove());
        await expect(sheet.getByRole('button', { name: /Fictional port mark/ })).toHaveCount(0);
        await page.keyboard.press('Escape');
        await expect(sheet).toHaveCount(0);
        await expect(page.getByRole('dialog', { name: 'Charts & detail', exact: true })).toBeVisible();
        await expect(entry).toBeFocused();
        expect(unexpected).toEqual([]);
    });
