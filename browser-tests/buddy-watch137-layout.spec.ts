import { expect, test } from '@playwright/test';
import { fixtureBackendOrigin } from './helpers/fixtureBackendOrigin';
const backendOrigin = fixtureBackendOrigin('https://buddy-watch.fixture.invalid');
for (const width of [300, 375])
    test(`buddy follow, held capability and chosen circle fit ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 640 });
        const saves: Record<string, unknown>[] = [],
            unexpected: string[] = [];
        const owner = '10000000-0000-4000-8000-000000000001',
            boat = '20000000-0000-4000-8000-000000000001',
            id = '30000000-0000-4000-8000-000000000001',
            revision = '40000000-0000-4000-8000-000000000001';
        const watches: unknown[] = [];
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (['localhost', '127.0.0.1'].includes(url.hostname)) return route.continue();
            if (url.origin === backendOrigin && url.pathname.startsWith('/rest/v1/rpc/')) {
                if (url.pathname.endsWith('/buddy_watch_list'))
                    return route.fulfill({
                        json: { schema: 1, ownerId: owner, boatId: boat, ready: false, checkedAt: Date.now(), watches },
                    });
                if (url.pathname.endsWith('/configure_buddy_watch')) {
                    const body = route.request().postDataJSON() as Record<string, unknown>;
                    saves.push(body);
                    watches.push({ id, revision, configuration: body.p_configuration, state: null });
                    return route.fulfill({ json: revision });
                }
            }
            unexpected.push(url.hostname + url.pathname);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/buddy-watch137.html');
        await page.getByRole('button', { name: 'Follow AIS MMSI 234567891' }).click();
        const dialog = page.getByRole('dialog', { name: 'Buddy boats' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText(/Notices held pending/)).toBeVisible();
        await expect(dialog.getByLabel('Your label')).toHaveValue('Generated public vessel');
        expect(saves).toEqual([]);
        await dialog.getByLabel('Watch entry/exit of a chosen circle').check();
        await dialog.getByLabel('Area name').fill('Generated public ocean circle');
        await dialog.getByLabel('Latitude', { exact: true }).fill('0');
        await dialog.getByLabel('Longitude').fill('179.9');
        const save = dialog.getByRole('button', { name: 'Follow boat' });
        await save.scrollIntoViewIfNeeded();
        await save.click();
        await expect(dialog.getByRole('button', { name: 'Enable notices' })).toBeDisabled();
        expect(saves).toHaveLength(1);
        expect(saves[0].p_configuration).toMatchObject({
            enabled: false,
            area: { lat: 0, lon: 179.9, radiusNm: 1, label: 'Generated public ocean circle' },
        });
        await expect(dialog.getByText(/current position unknown/)).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const close = dialog.getByRole('button', { name: 'Close buddy boats' });
        await expect(close).toBeVisible();
        const box = await close.boundingBox();
        expect(box && box.y >= 0 && box.y + box.height <= 640 && box.height >= 44).toBeTruthy();
        await page.screenshot({ path: test.info().outputPath('buddy-watch.png') });
        await close.click();
        await expect(dialog).toHaveCount(0);
        await expect(page.getByRole('dialog', { name: 'AIS targets' })).toBeVisible();
        expect(unexpected).toEqual([]);
    });
