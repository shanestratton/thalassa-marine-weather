import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
const directory = path.resolve('../ssh141-first-publication-rechecked/public');
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest-v2-a.json'), 'utf8'));
const asset = fs.readFileSync(path.join(directory, manifest.files[0].filename));
for (const width of [300, 375])
    test(`actual published ocean replay at ${width}px and130% text`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 780 });
        await page.clock.setFixedTime(new Date('2026-10-17T05:00:00Z'));
        const outbound: string[] = [],
            errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.pathname === '/api/ssh/manifest-v2.json')
                return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(manifest) });
            if (url.pathname === `/api/ssh/${manifest.files[0].filename}`)
                return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: asset });
            if (
                url.protocol === 'blob:' ||
                url.protocol === 'data:' ||
                ['127.0.0.1', 'localhost'].includes(url.hostname)
            )
                return route.continue();
            outbound.push(url.origin + url.pathname);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/ssh141.html');
        await page.addStyleTag({ content: 'html{font-size:130%}' });
        await page.getByRole('button', { name: 'Open layer menu' }).click();
        await page.getByRole('menuitem', { name: 'Sea layers' }).click();
        await page.getByRole('menuitemcheckbox', { name: 'Eddies · SLA, off' }).click();
        const evidence = () =>
            page.evaluate(() => window.__ssh141.evidence()) as Promise<{
                overlayIds: string[];
                sourceIds: string[];
                canvas: { width: number; height: number };
                scrollHeight: number;
                scrollWidth: number;
                mapErrors: string[];
                remoteAttempts: string[];
                pending: number;
                requests: string[];
            }>;
        await expect
            .poll(async () => (await evidence()).overlayIds.sort(), { timeout: 30000 })
            .toEqual(['observed-ssh-arrows-lines', 'observed-ssh-layer']);
        const before = await evidence();
        const extent = async () => {
            const value = await evidence();
            expect(value.scrollHeight).toBe(780);
            expect(value.scrollWidth).toBe(width);
            expect(value.canvas).toEqual(before.canvas);
            expect(value.mapErrors).toEqual([]);
            expect(value.remoteAttempts).toEqual([]);
        };
        await page.getByRole('button', { name: 'Close layer menu' }).click();
        const credits = page.getByTestId('obs-credits-rollup');
        expect((await credits.boundingBox())!.height).toBe(44);
        await credits.getByRole('button').click();
        const dialog = page.getByRole('dialog', { name: 'Map credits & source status' });
        await expect(dialog).toContainText('Ready. Mapped observation 2026-10-16 UTC');
        await expect(dialog).toContainText('Up to 96 viewport arrows');
        await expect(dialog).toContainText('Mercator Ocean');
        expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        await extent();
        await page.screenshot({ path: info.outputPath('dated-ocean-credits.png') });
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await page.evaluate(() => window.__ssh141.pan());
        await extent();
        await page.getByRole('button', { name: 'Open layer menu' }).click();
        await page.getByRole('menuitem', { name: 'Sea layers' }).click();
        await page.getByRole('menuitemcheckbox', { name: 'Sea height · ADT, off' }).click();
        await expect.poll(async () => (await evidence()).overlayIds.length).toBe(2);
        await page.getByRole('button', { name: 'Close layer menu' }).click();
        await credits.getByRole('button').click();
        await expect(dialog).toContainText('ADT above the geoid, metres');
        await expect(dialog).toContainText('Ready.');
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await extent();
        await page.screenshot({ path: info.outputPath('ocean-height-map.png') });
        await page.evaluate(() => window.__ssh141.off());
        await expect.poll(async () => (await evidence()).sourceIds.length).toBe(0);
        await page.evaluate(() => window.__ssh141.delay());
        await page.getByRole('button', { name: 'Open layer menu' }).click();
        await page.getByRole('menuitem', { name: 'Sea layers' }).click();
        await page.getByRole('menuitemcheckbox', { name: 'Eddies · SLA, off' }).click();
        await expect.poll(async () => (await evidence()).pending).toBe(1);
        await page.getByRole('menuitem', { name: /^Clear all · 1/ }).click();
        await page.evaluate(() => window.__ssh141.resolve());
        await page.waitForTimeout(150);
        expect((await evidence()).sourceIds).toEqual([]);
        expect(errors).toEqual([]);
        expect(outbound).toEqual([]);
        await extent();
        await info.attach('actual-source-replay.json', {
            body: JSON.stringify(
                {
                    publicationRun: 38999035362,
                    generation: manifest.generation,
                    evidence: await evidence(),
                    errors,
                    outbound,
                },
                null,
                2,
            ),
            contentType: 'application/json',
        });
    });
