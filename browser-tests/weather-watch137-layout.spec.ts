import { expect, test } from '@playwright/test';
for (const width of [300, 375])
    test(`weather watch explicit opt-ins and sample review fit ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 640 });
        const unexpected: string[] = [],
            saves: Record<string, unknown>[] = [];
        const revision = '30000000-0000-4000-8000-000000000001';
        let preferences = {
            morning: false,
            rain: false,
            storm: false,
            gust: false,
            hour: 7,
            zone: 'UTC',
            gustKts: null,
            samples: [],
        } as Record<string, unknown>;
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
            if (url.hostname === 'weather-watch.fixture.invalid' && url.pathname.startsWith('/rest/v1/rpc/')) {
                const call = url.pathname.split('/').at(-1);
                if (call === 'weather_watch_status') {
                    const cap = {
                        functionVersion: 1,
                        deliveryVersion: 1,
                        scheduled: true,
                        entitlementUntil: Date.now() + 3_600_000,
                        succeededAt: Date.now(),
                    };
                    return route.fulfill({
                        json: {
                            schema: 1,
                            profile: { revision, preferences },
                            capabilities: { morning: cap, rain: cap, storm: cap, gust: cap },
                            position: {
                                registration: {
                                    revision,
                                    relayId: 'fictional_relay_0001',
                                    selfKey: 'a'.repeat(64),
                                    sourceKey: 'b'.repeat(64),
                                    enabled: true,
                                },
                                position: { revision, lat: 0, lon: 0, at: Date.now() - 1000, zone: 'UTC' },
                            },
                        },
                    });
                }
                if (call === 'configure_weather_watch') {
                    const payload = route.request().postDataJSON() as Record<string, unknown>;
                    saves.push(payload);
                    preferences = payload.p_preferences as Record<string, unknown>;
                    return route.fulfill({ json: { revision, preferences } });
                }
            }
            unexpected.push(url.hostname + url.pathname);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/weather-watch137.html');
        await expect(page.getByRole('switch', { name: 'Morning briefing' })).toHaveAttribute('aria-checked', 'false');
        await page.getByRole('switch', { name: 'Morning briefing' }).click();
        await page.getByRole('switch', { name: 'Route and spot thunder risk' }).click();
        await page
            .getByRole('combobox', { name: 'Add a saved spot' })
            .selectOption({ label: 'Generated public ocean spot' });
        await page.getByRole('button', { name: 'Register followed route snapshot' }).click();
        await expect(page.getByRole('status')).toContainText('Gaps between these samples are not checked');
        expect(saves).toHaveLength(0);
        const save = page.getByRole('button', { name: 'Save forecast watch' });
        await save.scrollIntoViewIfNeeded();
        await save.click();
        await expect(page.getByRole('status')).toHaveText('Saved for this vessel.');
        expect(saves).toHaveLength(1);
        expect(saves[0].p_boat_id).toBe('20000000-0000-4000-8000-000000000001');
        expect(preferences.samples as unknown[]).toHaveLength(4);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(unexpected).toEqual([]);
        await page.screenshot({ path: test.info().outputPath('weather-watch.png'), fullPage: true });
    });
