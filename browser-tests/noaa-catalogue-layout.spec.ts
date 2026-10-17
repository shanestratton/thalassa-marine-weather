import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const hash = (body: Buffer): string => createHash('sha256').update(body).digest('hex');
const json = readFileSync('browser-tests/fixtures/noaa/US5CA1LK.json'),
    zip = readFileSync('browser-tests/fixtures/noaa/US5CA1LK.zip');
const generation = 'a'.repeat(24),
    agreement = '175f625ba0ae7b8656bf41010d6e5226b70f66a5a5c00ceff450c2eba2411c24';
for (const width of [300, 375])
    test(`NOAA original and chart import/render on phone at${width}px`, async ({ page }, testInfo) => {
        test.setTimeout(90000);
        await page.setViewportSize({ width, height: 667 });
        const cell = {
            id: 'US5CA1LK',
            title: 'San Pedro Channel - Isthmus Cove, Santa Catalina Island, CA',
            bbox: [-118.5, 33.45, -118.425, 33.525],
            edition: 1,
            update: 1,
            issued: '2026-04-22',
            baseIssued: '2026-02-13',
            scale: 12000,
            sourceUrl: 'https://www.charts.noaa.gov/ENCs/US5CA1LK.zip',
            chart: { key: `objects/${hash(json)}.json`, bytes: json.length, sha256: hash(json) },
            zip: { key: `objects/${hash(zip)}.zip`, bytes: zip.length, sha256: hash(zip) },
        };
        const shard = Buffer.from(JSON.stringify({ schema: 1, generation, cells: [cell] }));
        const region = {
            id: 'x06y12',
            bbox: [-120, 30, -110, 40],
            key: `generations/${generation}/shards/x06y12.json`,
            bytes: shard.length,
            sha256: hash(shard),
        };
        const index = {
            schema: 1,
            generation,
            checkedAt: new Date().toISOString(),
            sourceAt: new Date(Date.now() - 3600000).toISOString(),
            sourceSha256: 'b'.repeat(64),
            sourceUrl: 'https://charts.noaa.gov/ENCs/ENCProdCat_19115.xml',
            agreementUrl: 'https://charts.noaa.gov/ENCs/ENC_Agreement.shtml',
            agreementSha256: agreement,
            activeCells: 1,
            withdrawn: [],
            attribution: 'Contains NOAA ENC data. Not certified ECDIS.',
            shards: [region],
        };
        const bodies = new Map([
            ['index.json', Buffer.from(JSON.stringify(index))],
            [region.key, shard],
            [cell.chart.key, json],
            [cell.zip.key, zip],
        ]);
        const requests: string[] = [];
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.origin === 'https://tiles.thalassatiles.com') {
                requests.push(url.href);
                const body = bodies.get(url.pathname.replace('/noaa-enc/v1/', ''));
                return body
                    ? route.fulfill({
                          body,
                          headers: {
                              'access-control-allow-origin': '*',
                              'content-type': url.pathname.endsWith('.zip') ? 'application/zip' : 'application/json',
                          },
                      })
                    : route.abort();
            }
            if (['localhost', '127.0.0.1'].includes(url.hostname) || url.protocol === 'blob:') return route.continue();
            return route.abort();
        });
        await page.goto('/e2e/fixtures/noaa-catalogue.html');
        await page.getByRole('button', { name: 'Read NOAA agreement' }).click();
        const consent = page.getByRole('dialog', { name: 'NOAA chart agreement' });
        await expect(consent).toBeVisible();
        expect(requests).toHaveLength(0);
        await consent.getByRole('checkbox').check();
        await consent.getByRole('button', { name: 'Accept NOAA agreement' }).click();
        const sheet = page.getByRole('dialog', { name: 'NOAA ENC catalogue' });
        await expect(sheet.getByText(cell.title, { exact: true })).toBeVisible();
        expect(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await sheet.getByRole('button', { name: /Download ·/ }).click();
        await expect(sheet.getByRole('button', { name: 'Current copy saved' })).toBeVisible();
        await sheet.getByText('Saved original NOAA archives (1/32)', { exact: true }).click();
        await expect(sheet.getByText('Unaltered original ZIP retained on this device.', { exact: true })).toBeVisible();
        await sheet.getByRole('button', { name: 'Close', exact: true }).focus();
        await page.keyboard.press('Escape');
        await expect(sheet).toHaveCount(0);
        await expect(page.getByRole('status')).toHaveText('Map ready');
        const proof = await page.evaluate(async () => {
            const p = (
                window as unknown as {
                    __noaaProof: {
                        render: () => Promise<{
                            cell: { edition: number; updateNumber: number };
                            mergedCells: number;
                            depthFeatures: number;
                            sbdareOriginal: number;
                            sourceMounted: boolean;
                            renderedFeatures: number;
                            framebuffer: number[];
                        }>;
                    };
                }
            ).__noaaProof;
            return p.render();
        });
        expect(proof).toMatchObject({
            cell: { edition: 1, updateNumber: 1 },
            mergedCells: 1,
            sbdareOriginal: 35,
            sourceMounted: true,
        });
        expect(proof.depthFeatures).toBeGreaterThan(0);
        expect(proof.renderedFeatures).toBeGreaterThan(0);
        expect(proof.framebuffer[3]).toBe(255);
        expect(proof.framebuffer.slice(0, 3)).not.toEqual([0, 0, 0]);
        expect((await page.locator('canvas.mapboxgl-canvas').boundingBox())?.height).toBeGreaterThan(600);
        await testInfo.attach('noaa-render-proof', { body: JSON.stringify(proof), contentType: 'application/json' });
        await page.screenshot({ path: testInfo.outputPath('noaa-phone-chart.png') });
        expect(requests).toHaveLength(4);
        expect(requests.every((url) => !url.includes('?'))).toBe(true);
    });
