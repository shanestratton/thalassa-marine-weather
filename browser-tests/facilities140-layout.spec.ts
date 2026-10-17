import { expect, test } from '@playwright/test';
import { WORLD_FACILITY_COHORTS, LICENCES } from '../services/marineCatalogue/schema';
for (const width of [300, 375])
    test(`actual world facilities map/menu/popup/credits ${width}px130%`, async ({ page, baseURL }, info) => {
        await page.setViewportSize({ width, height: 667 });
        const errors: string[] = [],
            external: string[] = [],
            catalogue: string[] = [],
            origin = new URL(baseURL!).origin;
        page.on('pageerror', (error) => errors.push(error.message));
        const points = [
            {
                id: 'osm-node1',
                kind: 'marina',
                facilityKinds: ['marina'],
                lon: 0.082,
                lat: 0.1,
                name: 'Fictional marina',
            },
            {
                id: 'osm-way2',
                kind: 'fuel',
                facilityKinds: ['fuel'],
                lon: 0.094,
                lat: 0.1,
                name: 'Fictional fuel dock',
            },
            {
                id: 'osm-node3',
                kind: 'boat_ramp',
                facilityKinds: ['boat_ramp'],
                lon: 0.106,
                lat: 0.1,
                name: 'Fictional boat ramp',
            },
            {
                id: 'osm-relation4',
                kind: 'pump_out',
                facilityKinds: ['pump_out'],
                lon: 0.118,
                lat: 0.1,
                name: 'Fictional pump-out',
            },
        ].map((p) => ({ ...p, country: '', aliases: [], approximate: p.id === 'osm-relation4' }));
        const m = {
            schema: 1,
            dataset: 'facilities-world',
            generation: 'world-fixture',
            sourceAt: '2026-01-01T00:00:00Z',
            builtAt: '2026-01-02T00:00:00Z',
            count: 4,
            coverage: 'Fictional eight-cohort fixture; no real global data downloaded',
            licence: LICENCES['facilities-world'].url,
            sourceUrl: 'https://download.geofabrik.de/',
            cohorts: WORLD_FACILITY_COHORTS.map((id) => ({
                id,
                sourceAt: '2026-01-01T00:00:00Z',
                sha256: 'a'.repeat(64),
            })),
            shards: ['areas/45_90'],
        };
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.origin === origin) return route.continue();
            if (
                url.origin === 'https://tiles.thalassatiles.com' &&
                url.pathname.startsWith('/marine-catalogue/v1/facilities-world/')
            ) {
                catalogue.push(url.pathname);
                const body = url.pathname.endsWith('/manifest.json')
                    ? m
                    : { schema: 1, dataset: m.dataset, generation: m.generation, key: 'areas/45_90', records: points };
                return route.fulfill({
                    contentType: 'application/json',
                    body: JSON.stringify(body),
                    headers: { 'access-control-allow-origin': '*' },
                });
            }
            if (url.hostname.endsWith('mapbox.com'))
                return route.fulfill({ contentType: 'application/json', body: '{}' });
            external.push(url.origin + url.pathname);
            return route.abort();
        });
        await page.routeWebSocket('**/*', (socket) => socket.close());
        await page.goto('/e2e/fixtures/facilities140.html');
        await page.addStyleTag({ content: 'html{font-size:130%!important}' });
        // Readiness is the actual rendered map; never substitute a fake marker list.
        await expect.poll(() => page.evaluate(() => window.__facilitiesFixture?.ready())).toBe(true);
        const dims = () =>
            page.evaluate(() => ({
                w: document.documentElement.scrollWidth,
                h: document.documentElement.scrollHeight,
            }));
        const before = await dims();
        const mapBounds = (await page.getByRole('region', { name: 'Map', exact: true }).boundingBox())!;
        expect(mapBounds.width).toBe(width);
        expect(mapBounds.height).toBe(667);
        expect(catalogue).toEqual([]);
        await page.getByRole('button', { name: 'Open layer menu' }).click();
        await page.getByRole('menuitem', { name: 'Sea layers', exact: true }).click();
        const off = page.getByRole('menuitemcheckbox', { name: 'Facilities, off' });
        // The real helm menu scales in; sample its settled target rather than the first animation frame.
        await expect.poll(async () => (await off.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
        expect((await off.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await off.click();
        await expect(page.getByRole('menuitemcheckbox', { name: 'Facilities, on' })).toHaveAttribute(
            'aria-checked',
            'true',
        );
        await page.getByRole('button', { name: 'Close layer menu' }).click();
        await expect.poll(() => page.evaluate(() => window.__facilitiesFixture.count())).toBe(4);
        expect(catalogue).toHaveLength(2);
        expect(catalogue.every((p) => p.includes('/facilities-world/'))).toBe(true);
        await page.screenshot({ path: info.outputPath('facilities-map.png') });
        const credits = page.getByRole('button', { name: 'Credits; layer status needs review' });
        expect((await credits.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await credits.click();
        const panel = page.getByRole('dialog', { name: 'Map credits & source status' });
        await expect(panel).toContainText('Community data, may be incomplete');
        await expect(panel).toContainText('2026-01-01');
        await expect(panel).toContainText('older than');
        const bounds = (await panel.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(667);
        expect(await dims()).toEqual(before);
        await page.screenshot({ path: info.outputPath('facilities-credits.png') });
        await panel.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(panel).toHaveCount(0);
        const pos = await page.evaluate(() => window.__facilitiesFixture.project(0.118, 0.1));
        await page.mouse.click(pos.x, pos.y);
        const popup = page.locator('.world-facility-popup');
        await expect(popup).toContainText('Fictional pump-out');
        await expect(popup).toContainText('Representative area centre');
        await expect(popup).toContainText('Access and permission unknown');
        expect(await popup.evaluate((node) => node.scrollTop)).toBe(0);
        const title = popup.locator('strong');
        await expect(title).toBeInViewport();
        expect(
            await title.evaluate((node) => {
                const r = node.getBoundingClientRect();
                return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
            }),
        ).toBe(true);
        await expect(popup.getByRole('link', { name: 'View original OpenStreetMap object' })).toHaveAttribute(
            'href',
            'https://www.openstreetmap.org/relation/4',
        );
        for (const control of await popup.locator('a,button').all())
            expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        const popupBounds = (await popup.boundingBox())!;
        expect(popupBounds.x).toBeGreaterThanOrEqual(0);
        expect(popupBounds.x + popupBounds.width).toBeLessThanOrEqual(width);
        expect(popupBounds.y).toBeGreaterThanOrEqual(0);
        expect(popupBounds.y + popupBounds.height).toBeLessThanOrEqual(667);
        expect(await dims()).toEqual(before);
        await page.screenshot({ path: info.outputPath('facilities-popup.png') });
        await page.evaluate(() => window.__facilitiesFixture.foreground(false));
        await expect(popup).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => window.__facilitiesFixture.count())).toBe(0);
        const requests = catalogue.length;
        await page.evaluate(() => {
            window.__facilitiesFixture.satellite(true);
            window.__facilitiesFixture.foreground(true);
        });
        await expect.poll(() => page.evaluate(() => window.__facilitiesFixture.count())).toBe(4);
        expect(catalogue).toHaveLength(requests);
        await page.getByRole('button', { name: 'Credits; layer status needs review' }).click();
        await expect(panel).toContainText('Saved data; downloads paused');
        await panel.getByRole('button', { name: 'Close', exact: true }).click();
        await page.evaluate(() => window.__facilitiesFixture.identity());
        await expect.poll(() => page.evaluate(() => window.__facilitiesFixture.count())).toBe(4);
        expect(catalogue).toHaveLength(requests);
        await page.evaluate(() => window.__facilitiesFixture.clear());
        await expect.poll(() => page.evaluate(() => window.__facilitiesFixture.count())).toBe(0);
        await page.getByRole('button', { name: 'Credits; layer status needs review' }).click();
        await expect(panel).toContainText('may not be published or saved');
        await panel.getByRole('button', { name: 'Close', exact: true }).click();
        await page.evaluate(() => window.__facilitiesFixture.zoom(5));
        expect(catalogue).toHaveLength(requests);
        await page.getByRole('button', { name: 'Open layer menu' }).click();
        await page.getByRole('button', { name: /^Clear all/ }).click();
        await expect(page.getByTestId('obs-credits-rollup')).toHaveCount(0);
        expect(await dims()).toEqual(before);
        expect(errors).toEqual([]);
        expect(external).toEqual([]);
        await info.attach('bounded-catalogue-requests', {
            body: JSON.stringify({ requests: catalogue, errors, external, dimensions: before }, null, 2),
            contentType: 'application/json',
        });
    });
