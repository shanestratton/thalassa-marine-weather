import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import initSqlJs from 'sql.js';

/**
 * Offline MBTiles charts under the app's real Content Security Policy
 * (W1-FX item 1, e2e/fixtures/mbtiles-csp.ts). The chart is FICTIONAL and
 * built here: one solid tile in open ocean. Both policies are served as the
 * app serves them: index.html's meta (the native shell) and vercel.json's
 * header (the web app).
 *
 * Measured on 2026-10-08, before the fix, in WebKit and Chromium alike, the
 * chain died twice: sql.js could not compile its WebAssembly ("Refused to
 * create a WebAssembly object because 'unsafe-eval' or 'wasm-unsafe-eval' is
 * not an allowed source of script"), so no chart ever opened; and with that
 * stepped past, every tile Mapbox fetched as the blob: URL transformRequest
 * hands it was refused ("Refused to connect to blob:… because it does not
 * appear in the connect-src directive"). On the phone the chart file read was
 * a third refusal (file:// under connect-src): MBTilesService now reads it
 * through Capacitor.convertFileSrc (tests/MBTilesService.test.ts).
 *
 * This proves the service and policy path only. No skipper reaches it today:
 * the chart picker that would open a local chart is parked behind
 * CHARTS_FAB_CATEGORY_VISIBLE (components/map/mapHubHelpers.ts), and even
 * shown it lists only charts that are already open (useLocalCharts), so
 * nothing can be switched on. Reviving it needs a size gate first: open()
 * reads the whole file into the web view's memory.
 */

const ROOT = process.cwd();
const TILE_RGB = [255, 0, 200] as const;
// z4 x6 y8 holds the fixture's map centre (-33.75, -11), open Atlantic.
const TILE = { z: 4, x: 6, y: 8 };

function crc32(buf: Buffer): number {
    let c = ~0;
    for (const b of buf) {
        c ^= b;
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}

/** A 256×256 solid RGB PNG. */
function solidPng([r, g, b]: readonly number[]): Buffer {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(256, 0);
    ihdr.writeUInt32BE(256, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // truecolour
    const row = Buffer.alloc(1 + 256 * 3);
    for (let i = 0; i < 256; i++) row.set([r, g, b], 1 + i * 3);
    const raw = Buffer.concat(Array.from({ length: 256 }, () => row));
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

async function fictionalMbtiles(): Promise<Buffer> {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run('CREATE TABLE metadata (name TEXT, value TEXT)');
    db.run('CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)');
    for (const [k, v] of Object.entries({ name: 'Fictional ocean test', format: 'png', minzoom: '4', maxzoom: '4' })) {
        db.run('INSERT INTO metadata VALUES (?, ?)', [k, v]);
    }
    const tmsRow = (1 << TILE.z) - 1 - TILE.y;
    db.run('INSERT INTO tiles VALUES (?, ?, ?, ?)', [TILE.z, TILE.x, tmsRow, new Uint8Array(solidPng(TILE_RGB))]);
    const bytes = Buffer.from(db.export());
    db.close();
    return bytes;
}

function nativeShellCsp(): string {
    const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
    const m = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
    if (!m) throw new Error('index.html has no CSP meta');
    return m[1];
}

function webAppCsp(): string {
    const vercel = JSON.parse(readFileSync(resolve(ROOT, 'vercel.json'), 'utf8')) as {
        headers: Array<{ headers: Array<{ key: string; value: string }> }>;
    };
    const v = vercel.headers
        .flatMap((e) => e.headers)
        .find((h) => h.key.toLowerCase() === 'content-security-policy')?.value;
    if (!v) throw new Error('vercel.json has no CSP header');
    return v;
}

type Report = {
    ready: boolean;
    open: string;
    blobUrlsHanded: number;
    violations: Array<{ directive: string; blockedURI: string }>;
    mapErrors: string[];
    tileStates: string[];
};
type Fixture = { __mbtilesCsp: Report & { probe(lon: number, lat: number): number[] } };

for (const policy of ['index.html meta', 'vercel.json header'] as const) {
    test(`an offline MBTiles chart opens and its tile draws under the ${policy} CSP`, async ({ page }, testInfo) => {
        const mbtiles = await fictionalMbtiles();
        const refusals: string[] = [];
        page.on('console', (m) => {
            if (/refused|violates|content security policy/i.test(m.text())) refusals.push(m.text());
        });

        // The chart read: Filesystem.getUri on the web answers /CACHE/chart_downloads/<file>.
        await page.route('**/CACHE/chart_downloads/**', (route) =>
            route.fulfill({ body: mbtiles, contentType: 'application/octet-stream' }),
        );
        await page.route('**/e2e/fixtures/mbtiles-csp.html*', async (route) => {
            const res = await route.fetch();
            let body = await res.text();
            const headers = { ...res.headers() };
            if (policy === 'index.html meta') {
                const csp = nativeShellCsp().replace(/"/g, '&quot;');
                body = body.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}" />`);
            } else {
                headers['content-security-policy'] = webAppCsp();
            }
            await route.fulfill({ response: res, body, headers });
        });

        await page.goto('/e2e/fixtures/mbtiles-csp.html');
        await page.waitForFunction(() => (window as unknown as Partial<Fixture>).__mbtilesCsp?.ready === true, null, {
            timeout: 30_000,
        });
        const report = await page.evaluate(() => {
            const { probe: _probe, ...rest } = (window as unknown as Fixture).__mbtilesCsp;
            return rest as Report;
        });
        const tilePx = await page.evaluate(() => (window as unknown as Fixture).__mbtilesCsp.probe(-33.75, -11));
        // On screen but off the tile (it spans 45°W to 22.5°W): the fixture's
        // background, which says whether the canvas painted at all.
        const seaPx = await page.evaluate(() => (window as unknown as Fixture).__mbtilesCsp.probe(-48, -11));
        testInfo.annotations.push({ type: 'report', description: JSON.stringify({ report, tilePx, seaPx }) });

        expect(refusals, 'nothing in the chain is refused by the CSP').toEqual([]);
        expect(report.violations).toEqual([]);
        expect(report.open, 'the chart opens (sql.js compiled)').toMatch(/^ok png z4-4$/);
        expect(report.blobUrlsHanded, 'transformRequest handed Mapbox a blob: tile').toBeGreaterThan(0);
        expect(report.mapErrors).toEqual([]);
        expect(report.tileStates, 'Mapbox loaded the chart tile').toContain('loaded');

        // And the pixels, when this map is allowed to paint (the dev server's token).
        const painted = seaPx[3] > 0;
        testInfo.annotations.push({
            type: 'pixels',
            description: painted ? 'rendered' : 'canvas not painted (no token)',
        });
        if (painted) {
            expect(seaPx, 'the background beside the tile').toEqual([8, 36, 59, 255]);
            expect(tilePx, 'the chart tile is drawn at the map centre').toEqual([...TILE_RGB, 255]);
        }
    });
}
