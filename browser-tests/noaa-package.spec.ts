import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { partitionNoaaRecords } from '../scripts/noaa-enc/partition-records';
import { NOAA_AGREEMENT_SHA256, NOAA_AGREEMENT_URL } from '../services/enc/noaaAgreement';
import type { EncCell, EncConversionResult } from '../services/enc/types';
import type { NoaaDownload } from '../services/enc/noaaCatalogue';
const hash = (body: Buffer): string => createHash('sha256').update(body).digest('hex');
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
const api = <T>(page: Page, expression: string): Promise<T> =>
    page.evaluate<T>(`window.__noaaPackageProof.${expression}`);
type Inspection = {
    framebuffer: number[];
    canvasHeight: number;
    cell: EncCell | null;
    coverage: number;
    downloads: NoaaDownload[];
    residentBytes: number;
    oldWholeCellRefused: boolean;
    mounted: boolean;
    rendered: number;
};
function fixture(actual = false) {
    let packaged: ReturnType<typeof partitionNoaaRecords>, zip: Buffer;
    if (actual) {
        const root = process.env.NOAA_PACKAGE_PROOF_DIR!;
        const manifest = JSON.parse(readFileSync(path.join(root, 'result/package.json'), 'utf8'));
        packaged = {
            manifest,
            parts: manifest.parts.map((p: { sha256: string }) =>
                readFileSync(path.join(root, 'result', p.sha256 + '.json'), 'utf8'),
            ),
        };
        zip = readFileSync(path.join(root, 'original.zip'));
    } else {
        const source: EncConversionResult = {
            cellId: 'US3AK1EX',
            sourceHO: 'US',
            edition: 1,
            updateNumber: 0,
            issued: '2026-03-16',
            bbox: [-134, 55, -132, 56],
            soundingDatum: 12,
            layers: {
                DEPARE: {
                    type: 'FeatureCollection',
                    features: Array.from({ length: 32 }, (_, i) => {
                        const x = -134 + i / 20;
                        return {
                            type: 'Feature',
                            id: i,
                            properties: { DRVAL1: 2, DRVAL2: 4, synthetic: 'x'.repeat(650000) },
                            geometry: {
                                type: 'Polygon',
                                coordinates: [
                                    [
                                        [x - 0.02, 55.48],
                                        [x + 0.02, 55.48],
                                        [x + 0.02, 55.52],
                                        [x - 0.02, 55.52],
                                        [x - 0.02, 55.48],
                                    ],
                                ],
                            },
                        };
                    }),
                },
                M_SDAT: { type: 'FeatureCollection', features: [] },
            },
        };
        zip = Buffer.from([80, 75, 3, 4, 1, 2, 3, 4]);
        packaged = partitionNoaaRecords(source, hash(zip));
    }
    const manifest = encode(packaged.manifest),
        manifestSha = hash(manifest),
        generation = 'a'.repeat(24);
    const cell = {
        id: 'US3AK1EX',
        title: actual ? 'Retained official public NOAA source' : 'Synthetic public-format package',
        bbox: packaged.manifest.metadata.bbox,
        edition: 1,
        update: 0,
        issued: '2026-03-16',
        baseIssued: '2026-03-16',
        scale: 180000,
        sourceUrl: 'https://www.charts.noaa.gov/ENCs/US3AK1EX.zip',
        chart: null,
        zip: null,
        package: {
            manifest: { key: `objects/${manifestSha}.json`, sha256: manifestSha, bytes: manifest.length },
            zip: { key: `objects/${hash(zip)}.zip`, sha256: hash(zip), bytes: zip.length },
            bytes: manifest.length + packaged.manifest.bytes,
        },
    };
    const shard = encode({ schema: 1, generation, cells: [cell] });
    const entry = {
        id: 'x04y14',
        bbox: [-140, 50, -130, 60],
        key: `generations/${generation}/shards/x04y14.json`,
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
        agreementUrl: NOAA_AGREEMENT_URL,
        agreementSha256: NOAA_AGREEMENT_SHA256,
        activeCells: 1,
        withdrawn: [],
        attribution: 'NOAA public chart fixture. Not certified ECDIS.',
        shards: [entry],
    };
    const bodies = new Map<string, Buffer>([
        ['index.json', encode(index)],
        [entry.key, shard],
        [cell.package.manifest.key, manifest],
        [cell.package.zip.key, zip],
    ]);
    packaged.manifest.parts.forEach((p, i) => bodies.set(p.key, Buffer.from(packaged.parts[i])));
    return { bodies, cell, packaged };
}
async function routing(
    context: BrowserContext,
    bodies: Map<string, Buffer>,
    holdFirst?: { reached: boolean; release?: () => void },
) {
    const requests: string[] = [];
    const firstPart = [...bodies.keys()].find((k) => bodies.get(k)!.includes(Buffer.from('noaa-record-part')))!;
    await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === 'https://tiles.thalassatiles.com') {
            requests.push(url.href);
            const key = url.pathname.replace('/noaa-enc/v1/', '');
            if (holdFirst && key === firstPart && !holdFirst.reached) {
                holdFirst.reached = true;
                await new Promise<void>((resolve) => {
                    holdFirst.release = resolve;
                });
            }
            const body = bodies.get(key);
            if (!body) return route.abort();
            await route
                .fulfill({
                    body,
                    headers: {
                        'access-control-allow-origin': '*',
                        'content-type': key.endsWith('.zip') ? 'application/zip' : 'application/json',
                    },
                })
                .catch(() => undefined);
            return;
        }
        if (['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol === 'blob:') return route.continue();
        return route.abort();
    });
    return requests;
}
async function consent(page: Page) {
    await page.goto('/e2e/fixtures/noaa-package.html');
    await page.getByRole('button', { name: 'Read NOAA agreement' }).click();
    const agreement = page.getByRole('dialog', { name: 'NOAA chart agreement' });
    await agreement.getByRole('checkbox').check();
    await agreement.getByRole('button', { name: 'Accept NOAA agreement' }).click();
    await expect(page.getByRole('button', { name: /Download ·/ })).toBeVisible();
}
async function install(page: Page) {
    await page.getByRole('button', { name: /Download ·/ }).click();
    await expect(page.getByRole('button', { name: 'Current copy saved' })).toBeVisible({ timeout: 45000 });
}
test('complete package survives a genuinely new browser context with local data and no WAN', async ({
    page,
    context,
    browser,
}, info) => {
    test.setTimeout(120000);
    const f = fixture(),
        requests = await routing(context, f.bodies);
    await consent(page);
    await install(page);
    await expect
        .poll(() => api<Inspection>(page, 'inspect()'), { timeout: 30000 })
        .toMatchObject({ coverage: 1, oldWholeCellRefused: true, mounted: true });
    await expect.poll(async () => (await api<Inspection>(page, 'inspect()')).rendered).toBeGreaterThan(0);
    await page
        .getByRole('dialog', { name: 'NOAA ENC catalogue' })
        .getByRole('button', { name: 'Close', exact: true })
        .click();
    await expect.poll(async () => (await api<Inspection>(page, 'inspect()')).canvasHeight).toBeGreaterThan(500);
    await expect
        .poll(async () => (await api<Inspection>(page, 'inspect()')).framebuffer)
        .not.toEqual([134, 185, 207, 255]);
    expect((await api<Inspection>(page, 'inspect()')).framebuffer[3]).toBe(255);
    await page.screenshot({ path: info.outputPath('package-rendered.png') });
    const view = await api<{ ids: number[] }>(page, 'view()');
    expect(view.ids).toEqual([4, 5, 6, 7]);
    expect((await api<Array<{ hazard: boolean }>>(page, 'query()'))[0].hazard).toBe(true);
    await expect(api(page, 'view([-134,55,-132,56])')).rejects.toThrow(/resident/);
    await api(page, 'satellite(true)');
    const stored = await context.storageState({ indexedDB: true });
    const cold = await browser.newContext({ storageState: stored, viewport: { width: 375, height: 667 } });
    try {
        const coldRequests = await routing(cold, f.bodies),
            second = await cold.newPage();
        await second.goto('/e2e/fixtures/noaa-package.html');
        await expect(second.getByRole('button', { name: 'Current copy saved' })).toBeVisible({ timeout: 30000 });
        const local = await api<{ ids: number[] }>(second, 'view()');
        expect(local.ids).toEqual(view.ids);
        expect(coldRequests).toEqual([]);
        const proof = await api<Inspection>(second, 'inspect()');
        expect(proof.oldWholeCellRefused).toBe(true);
        expect(proof.downloads[0].bytes).toBe(f.cell.package.bytes + f.cell.package.zip.bytes);
        await info.attach('cold-package-proof', { body: JSON.stringify(proof), contentType: 'application/json' });
    } finally {
        await cold.close();
    }
    expect(requests.every((u) => !u.includes('?'))).toBe(true);
});
test('cancel/tamper/account transitions fail closed and cleanup preserves a later manual revision', async ({
    page,
    context,
}) => {
    test.setTimeout(120000);
    const f = fixture(),
        hold = { reached: false } as { reached: boolean; release?: () => void };
    await routing(context, f.bodies, hold);
    await consent(page);
    await page.getByRole('button', { name: /Download ·/ }).click();
    await expect.poll(() => hold.reached).toBe(true);
    await page
        .getByRole('dialog', { name: 'NOAA ENC catalogue' })
        .getByRole('button', { name: 'Close', exact: true })
        .click();
    hold.release!();
    await expect
        .poll(() => api<Inspection>(page, 'inspect()'))
        .toMatchObject({ cell: null, coverage: 0, downloads: [{ installed: false }] });
    await page.getByRole('button', { name: 'Open NOAA catalogue' }).click();
    await install(page);
    await api(page, "account('different-synthetic-owner')");
    expect((await api<Inspection>(page, 'inspect()')).coverage).toBe(0);
    await api(page, "account('noaa-package-synthetic')");
    await api(page, 'corruptFirstPart()');
    await expect(api(page, 'view()')).rejects.toThrow(/incomplete|changed/);
    expect((await api<Array<{ covered: boolean }>>(page, 'query()'))[0].covered).toBe(false);
    await api(page, 'replaceManual()');
    await api(page, 'removeOriginal()');
    const final = await api<Inspection>(page, 'inspect()');
    expect(final.cell?.edition).toBe(2);
    expect(final.cell?.contentSha256).toBe('d'.repeat(64));
    expect(final.downloads).toEqual([]);
    expect(final.oldWholeCellRefused).toBe(false);
});
test('retained actual public NOAA package installs and serves complete local windows', async ({
    page,
    context,
}, info) => {
    test.skip(
        !process.env.NOAA_PACKAGE_PROOF_DIR,
        'Requires the reviewed retained public-source proof artifact; synthetic cases always run.',
    );
    test.setTimeout(120000);
    const f = fixture(true);
    await routing(context, f.bodies);
    await consent(page);
    await install(page);
    await expect.poll(async () => (await api<Inspection>(page, 'inspect()')).rendered).toBeGreaterThan(0);
    const view = await api<{ bytes: number; layerCounts: Record<string, number> }>(page, 'view()');
    expect(Object.values(view.layerCounts).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(view.bytes).toBeLessThan(12 * 1024 * 1024);
    const state = await api<Inspection>(page, 'inspect()');
    expect(state.oldWholeCellRefused).toBe(true);
    expect(state.downloads[0].bytes).toBe(21058716);
    await info.attach('actual-source-window', {
        body: JSON.stringify({ ...state, view }),
        contentType: 'application/json',
    });
});
