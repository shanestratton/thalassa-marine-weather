import { test, expect } from '@playwright/test';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildCabin } from '../scripts/build-cabin.mjs';
import { CabinAccess } from '../src/cabin/access';
import { createCabinApp } from '../src/cabin/server';
import type { LanTelemetryPayload } from '../src/lanTelemetry';

let server: Server,
    origin: string,
    stale = false,
    generation = 0,
    codeNonce = 'a'.repeat(32);
const repository = path.resolve(import.meta.dirname, '../..');
test.beforeAll(async ({ browserName }, info) => {
    if (!['chromium', 'webkit'].includes(browserName)) throw Error('Reviewed cabin proof requires Chrome or WebKit');
    const base = process.env.CABIN142_ASSETS_OUTPUT;
    if (!base || !path.isAbsolute(base)) throw Error('Fresh absolute cabin proof output required');
    const assets = path.join(base, info.project.name);
    process.chdir(repository);
    await buildCabin({ repository, output: assets });
    const issued = Date.now();
    const access = new CabinAccess({
        binding: () => 'c'.repeat(64),
        context: () => `synthetic-owner:${generation}`,
        code: () => ({
            schema: 1,
            nonce: codeNonce,
            codeHash: createHash('sha256').update('12345678').digest('hex'),
            ownerBinding: 'c'.repeat(64),
            issuedAt: issued,
            expiresAt: issued + 600_000,
        }),
    });
    const read = async (): Promise<LanTelemetryPayload> => {
        const now = Date.now(),
            at = now - (stale ? 60_000 : 1_000);
        return {
            available: true,
            served_at: new Date(now).toISOString(),
            ais: [],
            telemetry: {
                reported_at: new Date(at).toISOString(),
                heading_deg: 82,
                pressure_hpa: 1012,
                depth_m: 4.8,
                sog_kts: 5.3,
                tws_kts: 17,
                private_secret: 'must-never-be-projected',
            },
            ais_watch: {
                v: 1,
                state: 'armed',
                armed: true,
                armedAt: at - 60_000,
                lastPassAt: at,
                servedAt: now,
                atAnchor: true,
                own: 'stopped',
                lastAisAt: at,
                targets: 1,
                prefs: null,
                ownMmsi: null,
                devices: 1,
                push: { state: 'ready', checkedAt: at, ownerId: 'synthetic-owner' },
                alarms: [
                    {
                        key: 'synthetic',
                        kind: 'collision',
                        mmsi: 503000111,
                        name: 'Synthetic <target>',
                        cpaNm: 0.1,
                        tcpaMin: 5,
                        rangeNm: 1,
                        bearingDeg: 90,
                        lat: -27,
                        lon: 153,
                        raisedAt: issued,
                        ackedAt: null,
                        lost: null,
                    },
                ],
            },
        };
    };
    server = createCabinApp({
        access,
        assets,
        read,
        peerAllowed: () => true,
        anchor: () => ({ running: true, dragging: false }),
    }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

for (const width of [300, 375])
    test(`actual read-only cabin at ${width}px and130percent type`, async ({ browser }, info) => {
        stale = false;
        generation++;
        codeNonce = generation.toString(16).padStart(32, '0');
        const page = await browser.newPage({ viewport: { width, height: 667 } });
        const errors: string[] = [],
            csp: string[] = [],
            requests: { method: string; path: string }[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
            if (/content.security.policy|refused to/i.test(message.text())) csp.push(message.text().slice(0, 200));
        });
        await page.route('**/*', (route) =>
            route
                .request()
                .url()
                .startsWith(origin + '/')
                ? route.continue()
                : route.abort(),
        );
        page.on('request', (request) => {
            const url = new URL(request.url());
            if (url.pathname.startsWith('/api/')) requests.push({ method: request.method(), path: url.pathname });
        });
        await page.goto(origin + '/cabin/');
        await page.evaluate(() => {
            document.documentElement.style.fontSize = '130%';
        });
        await page.getByLabel('Cabin code').fill('12345678');
        await page.getByRole('button', { name: 'Show instruments' }).click();
        await expect(page.getByRole('img', { name: /Heading from Pi, 082 degrees/ })).toBeVisible();
        await expect(page.getByText('Synthetic <target>', { exact: false })).toBeVisible();
        await expect(page.getByText('Anchor watch active · latest drag status unavailable')).toBeVisible();
        expect(await page.getByRole('button', { name: /arm|silence|stand.down|acknowledge/i }).count()).toBe(0);
        const geometry = await page.evaluate(() => ({
            width: innerWidth,
            scroll: document.documentElement.scrollWidth,
            stored: localStorage.length + sessionStorage.length,
            text: document.body.textContent?.includes('must-never-be-projected'),
        }));
        expect(geometry.scroll).toBeLessThanOrEqual(width);
        expect(geometry.stored).toBe(0);
        expect(geometry.text).toBe(false);
        await page.screenshot({ path: info.outputPath('paired.png'), fullPage: true });
        stale = true;
        await expect(page.getByRole('status')).toHaveText('Instrument data unavailable or old');
        await expect(page.getByRole('img', { name: /Heading from Pi, no data/ })).toBeVisible();
        await expect(page.getByText('Watch status is old or unavailable')).toBeVisible();
        await expect(page.getByText(/last reported/)).toBeVisible();
        await page.screenshot({ path: info.outputPath('old-data.png'), fullPage: true });
        generation++;
        await expect(page.getByRole('heading', { name: 'Pair this display' })).toBeVisible();
        expect(
            requests.every((request) => request.path === '/api/cabin/pair' || request.path === '/api/telemetry'),
        ).toBe(true);
        expect(errors).toEqual([]);
        expect(csp).toEqual([]);
        await info.attach('actual-cabin-proof', {
            body: JSON.stringify({
                width,
                fontPercent: 130,
                geometry,
                requests,
                errors,
                csp,
                actualSharedGauges: true,
                actualReadOnlyHttpApp: true,
                source: process.env.CABIN142_PROOF_SOURCE,
                providerReads: false,
                commands: false,
                hardwareAcceptance: false,
            }),
            contentType: 'application/json',
        });
        await page.close();
    });
