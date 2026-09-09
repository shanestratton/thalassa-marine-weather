import { expect, test, type Locator, type Page } from '@playwright/test';
import type { VoyageLogData, VoyageLogEntry, VoyageLogInstruments } from '../src/voyageLogApi';

const VESSEL_NAME = 'Serene Summer — Our Long Passage Around the Coral Sea';
const DESTINATION_NAME = 'Lady Musgrave Island and the Southern Great Barrier Reef Lagoon';
const DIARY_BODY = Array.from(
    { length: 28 },
    (_, index) =>
        `Watch ${index + 1}: We followed the reef edge, checked the anchorage and wrote down the changing weather. Everyone aboard enjoyed the quiet water and the view across the lagoon.`,
).join('\n\n');

function voyageData(trip: string | null): VoyageLogData {
    const now = new Date().toISOString();
    const historical = trip === 'old-trip';
    const instruments: VoyageLogInstruments = {
        updated_at: now,
        source: 'pi',
        sog: 5.8,
        cog: 43,
        heading: 43,
        stw: 5.5,
        tws: 12,
        twa: 70,
        twd: 113,
        aws: 15,
        awa: 55,
        depth: 18,
        water_temp: 24,
        baro: 1019,
        voltage: 12.8,
        rpm: 0,
        heel: 4,
        pitch: 1,
        rudder: 0,
        heel_at: now,
        pitch_at: now,
    };
    const entries: VoyageLogEntry[] = Array.from({ length: 24 }, (_, index) => ({
        id: `entry-${index + 1}`,
        title: `Lagoon journal ${index + 1}`,
        body: DIARY_BODY,
        mood: 'good',
        photos: [],
        location_name: DESTINATION_NAME,
        latitude: index === 0 ? -24.05 : null,
        longitude: index === 0 ? 152.365 : null,
        weather_summary: 'Gentle trade winds and clear skies.',
        weather_data: null,
        tags: [],
        created_at: now,
        voyage_id: historical ? 'old-trip' : 'latest-trip',
        author: null,
    }));
    return {
        vessel: { name: VESSEL_NAME, type: 'sail', model: 'Tayana 55 ocean passage sailing vessel' },
        scope: 'personal',
        destination: { name: DESTINATION_NAME, lat: -23.89, lon: 152.43 },
        trips: [
            {
                id: 'latest-trip',
                kind: 'track',
                label: 'Newport to Lady Musgrave Island via the Southern Great Barrier Reef',
                started_at: now,
                ended_at: null,
                active: true,
                point_count: 2,
                distance_nm: 32,
                has_route: true,
            },
            {
                id: 'old-trip',
                kind: 'track',
                label: 'A completed passage with a deliberately long name for a small phone',
                started_at: '2026-01-01T00:00:00Z',
                ended_at: '2026-01-02T00:00:00Z',
                active: false,
                point_count: 2,
                distance_nm: 20,
                has_route: true,
            },
        ],
        selected_trip: historical ? 'old-trip' : 'latest-trip',
        entries,
        track: [
            { lat: -24.2, lon: 152.3 },
            { lat: -23.94, lon: 152.4 },
        ].map((point) => ({
            ...point,
            timestamp: now,
            voyage_id: historical ? 'old-trip' : 'latest-trip',
            speed_kts: 5.8,
            course_deg: 43,
            heading_deg: 43,
            pressure: 1019,
            wind_speed_apparent: 15,
            wind_angle_apparent: 55,
            wind_speed_true: 12,
            wind_direction_true: 113,
            depth_m: 18,
            air_temp: 25,
            water_temp: 24,
            wave_height: 0.5,
        })),
        telemetry: null,
        // Retain readings in the historical fixture to exercise the UI's
        // own latest-only boundary, rather than making the fixture hide them.
        instruments_shared: true,
        instruments,
        nearby_vessels: [],
        waypoints: [],
        passage: {
            plan_line: [
                [152.3, -24.2],
                [152.43, -23.89],
            ],
        },
        generated_at: now,
    };
}

async function openVoyage(page: Page, baseURL: string) {
    const origin = new URL(baseURL).origin;
    await page.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname.endsWith('/functions/v1/voyage-log')) {
            expect(request.method()).toBe('GET');
            const data = voyageData(url.searchParams.get('trip'));
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                headers: { 'access-control-allow-origin': '*' },
                body: JSON.stringify(
                    url.searchParams.get('view') === 'instruments'
                        ? {
                              instruments_shared: data.instruments_shared,
                              instruments: data.instruments,
                              generated_at: data.generated_at,
                          }
                        : data,
                ),
            });
        } else if (url.origin === origin) {
            await route.continue();
        } else if (url.hostname.endsWith('mapbox.com') && url.pathname.includes('/styles/v1/')) {
            // Exercise the real map wrapper without downloading imagery or
            // sending the build's publishable map token to a remote service.
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    version: 8,
                    sources: {},
                    layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0f2433' } }],
                }),
            });
        } else {
            await route.abort();
        }
    });
    await page.goto('/logs.html?handle=mobile-layout-fixture');
    await expect(page.locator('h1')).toHaveText(VESSEL_NAME);
}

async function expectNoPageOverflow(page: Page) {
    const geometry = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth - window.innerWidth,
        height: document.documentElement.scrollHeight - window.innerHeight,
        left: window.scrollX,
        top: window.scrollY,
    }));
    expect(geometry.width).toBeLessThanOrEqual(1);
    expect(geometry.height).toBeLessThanOrEqual(1);
    expect(geometry.left).toBe(0);
    expect(geometry.top).toBe(0);
}

async function expectInViewport(element: Locator, page: Page) {
    const box = await element.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.y).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
}

for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 430, height: 932 },
    { width: 740, height: 360 },
    { width: 844, height: 390 },
    { width: 768, height: 1024 },
]) {
    test(`public voyage has room for the map and reachable views at ${viewport.width}x${viewport.height}`, async ({
        page,
        baseURL,
    }, testInfo) => {
        test.setTimeout(60_000);
        await page.setViewportSize(viewport);
        await openVoyage(page, baseURL!);
        const map = page.locator('#voyage-map');
        const nav = page.getByRole('navigation', { name: 'Voyage views' });
        const mapButton = nav.getByRole('button', { name: 'Map', exact: true });
        const instrumentsButton = nav.getByRole('button', { name: 'Instruments', exact: true });
        const diaryButton = nav.getByRole('button', { name: 'Diary', exact: true });
        await expect(map).toBeVisible();
        await expect(mapButton).toHaveAttribute('aria-pressed', 'true');
        await expectInViewport(map, page);
        const mapBox = (await map.boundingBox())!;
        expect(mapBox.y).toBeLessThanOrEqual(180);
        expect(mapBox.height).toBeGreaterThanOrEqual(
            viewport.height < 400 ? 130 : viewport.height * (viewport.width === 320 ? 0.55 : 0.6),
        );
        for (const control of [mapButton, instrumentsButton, diaryButton]) {
            await expectInViewport(control, page);
            const box = (await control.boundingBox())!;
            expect(box.height).toBeGreaterThanOrEqual(44);
            expect(box.width).toBeGreaterThanOrEqual(44);
        }
        await expectNoPageOverflow(page);

        const mapElement = await map.locator(':scope > div').elementHandle();
        expect(mapElement).not.toBeNull();
        const canvas = map.locator('.mapboxgl-canvas');
        const canvasElement = (await canvas.count()) ? await canvas.elementHandle() : null;
        const selector = page.getByRole('combobox', { name: 'Choose a voyage to view' });
        const expand = page.getByRole('button', { name: 'Expand map', exact: true });
        const restore = page.getByRole('button', { name: 'Restore page header', exact: true });
        // Short landscape starts with the header folded. Its restore door
        // must still expose the voyage picker without changing map identity.
        if (viewport.height < 400) await restore.click();
        await expect(selector).toBeVisible();
        expect((await selector.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        for (const control of [expand, restore]) {
            if (control === restore) await expand.click();
            await expectInViewport(control, page);
            const box = (await control.boundingBox())!;
            expect(box.height).toBeGreaterThanOrEqual(44);
            expect(box.width).toBeGreaterThanOrEqual(44);
        }
        await expect(selector).toBeHidden();
        expect((await map.boundingBox())!.y).toBeLessThanOrEqual(1);
        const expandedMap = (await map.boundingBox())!;
        const expandedNav = (await nav.boundingBox())!;
        // Expansion gives every pixel above the persistent navigation to the
        // map, including on short landscape screens with a 44px touch floor.
        expect(expandedMap.height).toBeGreaterThanOrEqual(viewport.height - expandedNav.height - 1);
        if (viewport.height >= 400) expect(expandedMap.height).toBeGreaterThanOrEqual(viewport.height * 0.85);
        await restore.click();
        await expect(selector).toBeVisible();
        await expect(page.getByRole('heading', { name: VESSEL_NAME, exact: true })).toBeVisible();
        if (viewport.height < 400) await expand.click();
        expect(await mapElement!.evaluate((element) => element.isConnected)).toBe(true);
        // Basemap selection is local React state. Its persistence, plus the
        // original wrapper's identity, catches accidental map remounts even
        // on machines where WebGL cannot initialise a canvas.
        const basemap = page.getByRole('button', { name: 'Map basemap', exact: true });
        const hasMapControls = (await basemap.count()) > 0;
        if (hasMapControls) await basemap.click();
        const navBox = await nav.boundingBox();
        await page.screenshot({ path: testInfo.outputPath('public-voyage-map.png') });

        if (viewport.width === 390 && canvasElement) {
            const marker = page.getByRole('button', { name: 'Voyage log entry: Lagoon journal 1', exact: true });
            await marker.focus();
            await marker.press('Enter');
            await expect(diaryButton).toHaveAttribute('aria-pressed', 'true');
            await expect(map).toBeHidden();
            await expect(page.locator('#voyage-panel-content')).toBeFocused();
            await page.getByRole('button', { name: 'Back to all entries' }).click();
            await mapButton.click();
            await expect(map).toBeVisible();
        }

        await instrumentsButton.click();
        await expect(instrumentsButton).toHaveAttribute('aria-pressed', 'true');
        await expect(map).toBeHidden();
        await expect(page.getByRole('region', { name: 'Onboard instruments' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Lagoon journal 1', exact: true })).toHaveCount(0);
        await expectNoPageOverflow(page);

        await diaryButton.click();
        await expect(diaryButton).toHaveAttribute('aria-pressed', 'true');
        await expect(page.getByRole('region', { name: 'Onboard instruments' })).toHaveCount(0);
        const content = page.locator('#voyage-panel-content');
        await expect(content).toHaveCSS('overflow-y', 'auto');
        await expect(content).toHaveJSProperty('scrollTop', 0);
        const lastEntry = content.getByRole('button').filter({ hasText: 'Lagoon journal 24' });
        await lastEntry.scrollIntoViewIfNeeded();
        await expectInViewport(lastEntry, page);
        expect(await nav.boundingBox()).toEqual(navBox);
        await lastEntry.click();
        await expect(content.getByRole('button', { name: 'Back to all entries' })).toBeVisible();
        await expect(content).toHaveJSProperty('scrollTop', 0);
        await content.evaluate((element) => element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }));
        await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        const weather = content.getByText('Gentle trade winds and clear skies.', { exact: true });
        await expectInViewport(weather, page);
        expect(await nav.boundingBox()).toEqual(navBox);
        await expectNoPageOverflow(page);
        await page.screenshot({ path: testInfo.outputPath('public-voyage-diary-bottom.png') });

        await mapButton.click();
        await expect(map).toBeVisible();
        expect(
            await mapElement!.evaluate(
                (element) => element.isConnected && element === document.querySelector('#voyage-map > div'),
            ),
        ).toBe(true);
        if (canvasElement) expect(await canvasElement.evaluate((element) => element.isConnected)).toBe(true);
        if (hasMapControls) await expect(basemap).toHaveAttribute('aria-pressed', 'true');
        await expect(page.getByRole('region', { name: 'Onboard instruments' })).toHaveCount(0);
        await expectNoPageOverflow(page);
    });
}

test('mobile historical selection withdraws instruments and keeps diary navigation reachable', async ({
    page,
    baseURL,
}) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openVoyage(page, baseURL!);
    const nav = page.getByRole('navigation', { name: 'Voyage views' });
    const instruments = nav.getByRole('button', { name: 'Instruments', exact: true });
    await instruments.click();
    await expect(page.getByRole('region', { name: 'Onboard instruments' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Choose a voyage to view' }).selectOption('old-trip');
    await expect(instruments).toBeDisabled();
    await expect(page.getByRole('region', { name: 'Onboard instruments' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Instrument sharing status' })).toHaveCount(0);
    await expect(nav.getByRole('button', { name: 'Diary', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('heading', { name: 'Lagoon journal 1', exact: true })).toBeVisible();
    await expectNoPageOverflow(page);
});

test('desktop retains the simultaneous map and exclusive side panel', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openVoyage(page, baseURL!);
    const map = page.locator('#voyage-map');
    const panel = page.locator('#voyage-side-panel');
    const switcher = page.getByRole('group', { name: 'Side panel view' });
    await expect(map).toBeVisible();
    await expect(panel).toBeVisible();
    await expect(switcher).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Voyage views' })).toBeHidden();
    await expect(page.getByRole('region', { name: 'Onboard instruments' })).toBeVisible();
    expect((await map.boundingBox())!.x + (await map.boundingBox())!.width).toBeLessThanOrEqual(
        (await panel.boundingBox())!.x + 1,
    );
    const mapElement = await map.locator(':scope > div').elementHandle();
    await switcher.getByRole('button', { name: 'Diary', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Onboard instruments' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Lagoon journal 1', exact: true })).toBeVisible();
    expect(await mapElement!.evaluate((element) => element.isConnected)).toBe(true);
    await expectInViewport(map, page);
    await expectNoPageOverflow(page);
});
