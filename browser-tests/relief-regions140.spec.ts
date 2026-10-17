import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RegionalReliefFixture } from '../e2e/fixtures/relief-regions140';
interface Replay {
    url: string;
    file: string;
    sha256: string;
    bytes: number;
    contentType: string;
}
const replay = resolve(process.cwd(), '../../work/relief140-public-replay');
const files = (JSON.parse(readFileSync(resolve(replay, 'receipt.json'), 'utf8')) as { receipts: Replay[] }).receipts;
for (const width of [300, 375])
    test(`published AU/NZ tiles, source retirement and capped credits at${width}px130%`, async ({ page }, info) => {
        test.setTimeout(90000);
        await page.setViewportSize({ width, height: 780 });
        const requested: string[] = [],
            replayed: string[] = [],
            pageErrors: string[] = [];
        let offline = false;
        page.on('pageerror', (e) => pageErrors.push(e.message));
        await page.route('**/*', (route) => {
            const url = route.request().url(),
                u = new URL(url);
            if (u.origin === 'http://127.0.0.1:4296') return route.continue();
            if (u.origin === 'https://tiles.thalassatiles.com') {
                requested.push(url);
                if (offline) return route.abort();
                const found = files.find((f) => f.url === url);
                if (!found) return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' } });
                replayed.push(url);
                return route.fulfill({
                    status: 200,
                    body: readFileSync(resolve(replay, found.file)),
                    contentType: found.contentType,
                    headers: { 'access-control-allow-origin': '*' },
                });
            }
            return route.abort();
        });
        await page.goto('/e2e/fixtures/relief-regions140.html');
        await page.evaluate(async () => {
            document.documentElement.style.fontSize = '130%';
            await (window as unknown as { __relief140: RegionalReliefFixture }).__relief140.ready();
        });
        await expect
            .poll(
                () =>
                    page.evaluate(async () => {
                        const p = await (
                            window as unknown as { __relief140: RegionalReliefFixture }
                        ).__relief140.probe();
                        return p.nonBackground;
                    }),
                { timeout: 15000 },
            )
            .toBeGreaterThan(50);
        const first = await page.evaluate(() =>
            (window as unknown as { __relief140: RegionalReliefFixture }).__relief140.probe(),
        );
        expect(first.sources).toContain('relief-nz-idx');
        expect(first.pixelColours).toBeGreaterThan(1);
        expect(first.attribution).toContain('NZVD2016');
        expect(first.attribution).toContain('not MSL');
        const geometry = () =>
            page.evaluate(() => ({
                width: innerWidth,
                height: innerHeight,
                scrollWidth: document.documentElement.scrollWidth,
                scrollHeight: document.documentElement.scrollHeight,
                fontSize: getComputedStyle(document.documentElement).fontSize,
                map: document.getElementById('map')!.getBoundingClientRect().toJSON(),
                row: document.querySelector('[data-testid="obs-credits-rollup"]')!.getBoundingClientRect().toJSON(),
            }));
        const before = await geometry();
        expect(before.scrollWidth).toBe(width);
        expect(before.scrollHeight).toBe(780);
        expect(before.row.height).toBe(44);
        expect(Number.parseFloat(before.fontSize)).toBeGreaterThanOrEqual(20.7);
        await page.getByRole('button', { name: 'Credits', exact: true }).click();
        const credits = page.getByRole('dialog', { name: 'Map credits & source status' });
        await expect(credits).toBeVisible();
        await expect(credits).toContainText('NZVD2016 native heights; not MSL');
        await expect(credits).toContainText('No vertical conversion');
        await expect(credits).toContainText('not whole-country');
        await expect(credits.getByRole('link', { name: 'New Zealand · 61 surveyed coastal patches' })).toHaveAttribute(
            'href',
            'https://data.linz.govt.nz/layer/122508-new-zealand-coastal-lidar-1m-dem/',
        );
        const panel = credits.locator('[data-modal-sheet]');
        const creditBox = await panel.boundingBox();
        expect(creditBox!.y).toBeGreaterThanOrEqual(0);
        expect(creditBox!.y + creditBox!.height).toBeLessThanOrEqual(781);
        const creditGeometry = await geometry();
        expect(creditGeometry.scrollWidth).toBe(width);
        expect(creditGeometry.scrollHeight).toBe(780);
        expect(creditBox!.height).toBeLessThanOrEqual(780 - 2 * Number.parseFloat(before.fontSize) + 1);
        await page.screenshot({ path: info.outputPath('credits.png') });
        const nzDatum = credits.getByText(
            'NZVD2016 native heights; not MSL. No vertical conversion; coarse GEBCO fallback uses approximate MSL.',
            { exact: true },
        );
        await nzDatum.scrollIntoViewIfNeeded();
        await expect(nzDatum).toBeVisible();
        await page.screenshot({ path: info.outputPath('credits-native-datum.png') });
        await credits.getByRole('button', { name: 'Close', exact: true }).click();
        await page.getByRole('button', { name: 'Offline area', exact: true }).click();
        const sheet = page.getByRole('dialog', { name: 'Offline Relief' });
        await expect(sheet).toBeVisible();
        await expect(sheet).toContainText('NZVD2016');
        await expect(sheet.getByRole('slider', { name: 'Maximum relief detail' })).toHaveAttribute('max', '14');
        const offlineBox = await sheet.locator('[data-modal-sheet]').boundingBox();
        expect(offlineBox!.height).toBeLessThanOrEqual(780 - 12 * Number.parseFloat(before.fontSize) + 1);
        const offlineGeometry = await geometry();
        expect(offlineGeometry.scrollWidth).toBe(width);
        expect(offlineGeometry.scrollHeight).toBe(780);
        await page.screenshot({ path: info.outputPath('offline.png') });
        const slider = sheet.getByRole('slider', { name: 'Maximum relief detail' });
        await slider.scrollIntoViewIfNeeded();
        await slider.focus();
        await slider.press('End');
        await expect(slider).toHaveValue('14');
        await expect(sheet.getByRole('button', { name: 'Download relief', exact: true })).toBeEnabled();
        await page.screenshot({ path: info.outputPath('offline-planner-actions.png') });
        await sheet.getByRole('button', { name: 'Close', exact: true }).first().click();
        const saved = await page.evaluate(() =>
            (window as unknown as { __relief140: RegionalReliefFixture }).__relief140.save(),
        );
        expect(saved.progress?.phase).toBe('done');
        expect(saved.progress?.failed).toBe(0);
        expect(saved.storage.tiles).toBeGreaterThanOrEqual(2);
        const plan = await page.evaluate(() =>
            (window as unknown as { __relief140: RegionalReliefFixture }).__relief140.plan(),
        );
        expect(plan.tooLarge).toBe(false);
        expect(plan.tiles.some((t) => t.key === 'v2_nz_idx_14_15825_10578.png')).toBe(true);
        await page.evaluate(() => (window as unknown as { __relief140: RegionalReliefFixture }).__relief140.move('au'));
        await expect
            .poll(
                () =>
                    page.evaluate(async () => {
                        const p = await (
                            window as unknown as { __relief140: RegionalReliefFixture }
                        ).__relief140.probe();
                        return (
                            p.sources.includes('relief-au250-idx') &&
                            !p.sources.includes('relief-nz-idx') &&
                            p.nonBackground > 50
                        );
                    }),
                { timeout: 15000 },
            )
            .toBe(true);
        const australia = await page.evaluate(() =>
            (window as unknown as { __relief140: RegionalReliefFixture }).__relief140.probe(),
        );
        expect(australia.attribution).toContain('Approximately MSL');
        expect(australia.layers.indexOf('relief-au250-shade')).toBeLessThan(australia.layers.indexOf('relief-au-tint'));
        await page.screenshot({ path: info.outputPath('australia.png') });
        await page.evaluate(() =>
            (window as unknown as { __relief140: RegionalReliefFixture }).__relief140.move('gap'),
        );
        await expect
            .poll(() =>
                page.evaluate(async () => {
                    const p = await (window as unknown as { __relief140: RegionalReliefFixture }).__relief140.probe();
                    return p.sources.filter((s) => /relief-(nz|au250)-/.test(s)).length;
                }),
            )
            .toBe(0);
        const gap = await page.evaluate(() =>
            (window as unknown as { __relief140: RegionalReliefFixture }).__relief140.probe(),
        );
        expect(gap.pixelColours).toBe(1);
        expect(gap.nonBackground).toBe(0);
        offline = true;
        await page.evaluate(() =>
            (window as unknown as { __relief140: RegionalReliefFixture }).__relief140.prepareOffline(),
        );
        await page.reload();
        await page.evaluate(() => {
            document.documentElement.style.fontSize = '130%';
        });
        await expect
            .poll(
                () =>
                    page.evaluate(async () => {
                        const p = await (
                            window as unknown as { __relief140: RegionalReliefFixture }
                        ).__relief140.probe();
                        return p.nonBackground;
                    }),
                { timeout: 15000 },
            )
            .toBeGreaterThan(50)
            .catch(async (error) => {
                const failed = await page.evaluate(async () => {
                    const probe = await (
                        window as unknown as { __relief140: RegionalReliefFixture }
                    ).__relief140.probe();
                    const cache = await caches.open('thalassa-v195-tiles');
                    const keys = await cache.keys();
                    const worker = await new Promise((resolve) => {
                        const channel = new MessageChannel();
                        channel.port1.onmessage = (e) => resolve(e.data);
                        navigator.serviceWorker.controller!.postMessage('proof-requests', [channel.port2]);
                    });
                    return {
                        probe,
                        keys: keys.map((r) => r.url),
                        worker,
                        controller: navigator.serviceWorker.controller?.scriptURL,
                    };
                });
                await info.attach('offline-failure.json', {
                    body: JSON.stringify(failed, null, 2),
                    contentType: 'application/json',
                });
                throw error;
            });
        const cached = await page.evaluate(() =>
            (window as unknown as { __relief140: RegionalReliefFixture }).__relief140.probe(),
        );
        expect(cached.storage.tiles).toBeGreaterThanOrEqual(2);
        expect(cached.attribution).toContain('NZVD2016');
        const after = await geometry();
        expect(after.scrollWidth).toBe(width);
        expect(after.scrollHeight).toBe(780);
        expect(after.row.height).toBe(44);
        expect(after.fontSize).toBe(before.fontSize);
        expect(after.map).toEqual(before.map);
        expect(pageErrors).toEqual([]);
        expect(replayed.some((u) => u.endsWith('/relief-nz/idx/14/15825/10578.png'))).toBe(true);
        expect(replayed.some((u) => u.endsWith('/relief-au250/idx/8/193/133.png'))).toBe(true);
        await info.attach('regional-relief-proof.json', {
            body: JSON.stringify(
                {
                    first,
                    australia,
                    gap,
                    cached,
                    before,
                    after,
                    creditGeometry,
                    creditBox,
                    offlineGeometry,
                    offlineBox,
                    saved,
                    plan,
                    requested,
                    replayed,
                    pageErrors,
                },
                null,
                2,
            ),
            contentType: 'application/json',
        });
        await page.screenshot({ path: info.outputPath('saved-regional-tiles.png') });
    });
