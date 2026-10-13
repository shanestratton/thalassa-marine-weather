import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, test, type TestContext } from 'node:test';
import express from 'express';
import AdmZip from 'adm-zip';
import { ChartInstallError, publishChartDelivery, readChartIndex } from '../encChartStore.js';
import { type installOChartsDelivery } from '../oChartsInstaller.js';
import { EncDeviceStore } from '../encDevices.js';
import { VaultUnavailableError, type VaultClient } from '../vaultClient.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'enc-route-test-'));
process.env.ENC_CHART_DIR = path.join(root, 'store');
// Where the retired ChartWorld path used to drop an S-63 delivery (and its
// poller's config). Pointed into the test's own folder so the test can show
// nothing is written there; neither exists after 127.
const CHARTWORLD_INBOX = path.join(root, 'chartworld');
process.env.ENC_CHARTWORLD_DIR = CHARTWORLD_INBOX;
process.env.ENC_CHARTWORLD_CONFIG = path.join(root, 'no-chartworld-config.json');
const { createEncRoutes, looksLikeChartworld } = await import('./enc.js');
after(async () => {
    // A device store may still be writing its last sighting.
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** No protected cell is in this vault: the routes here are installs and the open store. */
const emptyVault: VaultClient = {
    status: async () => null,
    index: async () => [],
    openCell: async () => {
        throw new VaultUnavailableError('cell-not-found', 404);
    },
    rescan: async () => ({ queued: false }),
    remove: async () => false,
    hint: async () => {},
};

/** A real router behind its front door (127-C-d): an enrolled phone on the boat's Wi-Fi. */
async function harness(t: TestContext, installOCharts?: typeof installOChartsDelivery) {
    const devices = new EncDeviceStore(path.join(await fs.mkdtemp(path.join(root, 'cache-')), 'enc-devices.json'));
    const app = express();
    app.use(express.json());
    app.use(
        '/api/enc',
        createEncRoutes(undefined, {
            installOCharts,
            devices,
            vault: emptyVault,
            chartStoreDir: process.env.ENC_CHART_DIR,
            peerOf: () => '192.168.1.23',
            lanView: () => ({
                interfaces: {
                    eth0: [
                        {
                            address: '192.168.1.180',
                            netmask: '255.255.255.0',
                            family: 'IPv4',
                            internal: false,
                            mac: '',
                            cidr: '192.168.1.180/24',
                        },
                    ],
                },
                gateways: ['192.168.1.1'],
            }),
        }),
    );
    const server = app.listen(0);
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/enc`;
    const { code } = await devices.mintCode();
    const enrolled = (await (
        await fetch(`${base}/devices/enrol`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, label: 'iPhone' }),
        })
    ).json()) as { token: string };
    const call = (route: string, init: RequestInit = {}) =>
        fetch(`${base}${route}`, {
            ...init,
            headers: { ...(init.headers as Record<string, string>), 'X-Thalassa-Chart-Device': enrolled.token },
        });
    return { base, call };
}

function archive(): Buffer {
    const zip = new AdmZip();
    zip.addFile('set/FR466870.oesu', Buffer.from('encrypted fixture'));
    zip.addFile('set/oeuSENC-test-sgl1234.XML', Buffer.from('<keyList/>'));
    return zip.toBuffer();
}

async function poll(
    call: (route: string, init?: RequestInit) => Promise<Response>,
    jobId: string,
    predicate: (job: Record<string, unknown>) => boolean,
) {
    for (let i = 0; i < 100; i++) {
        const job = (await (await call(`/jobs/${jobId}`)).json()) as Record<string, unknown>;
        if (predicate(job)) return job;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('job polling timed out');
}

test('o-charts job remains converting until publication and exposes installed receipt without result URL', async (t) => {
    let complete!: () => void;
    const gate = new Promise<void>((resolve) => {
        complete = resolve;
    });
    const h = await harness(t, async (options) => {
        options.onProgress?.('Verifying converted charts', 0, 1);
        await gate;
        return {
            persistedCellIds: ['FR466870'],
            packageSummary: { new: 1, updated: 0, unchanged: 0, total: 1 },
            featureCount: 1,
            sourceArchiveId: 'fixture',
        };
    });
    const response = await h.call(`/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'charts.zip' },
        body: new Uint8Array(archive()),
    });
    assert.equal(response.status, 200);
    const { jobId } = (await response.json()) as { jobId: string };
    const converting = await poll(h.call, jobId, (job) => job.status === 'converting');
    assert.equal(converting.resultUrl, undefined);
    assert.equal((await h.call(`/jobs/${jobId}`, { method: 'DELETE' })).status, 409);
    complete();
    const ready = await poll(h.call, jobId, (job) => job.status === 'done');
    assert.equal(ready.resultKind, 'installed');
    assert.equal(ready.resultUrl, undefined);
    assert.deepEqual(ready.persistedCellIds, ['FR466870']);
    assert.deepEqual(ready.packageSummary, { new: 1, updated: 0, unchanged: 0, total: 1 });
    const recent = (await (await h.call(`/jobs`)).json()) as { jobs: Record<string, unknown>[] };
    assert.ok(recent.jobs.some((job) => job.id === jobId && job.resultKind === 'installed'));
});

/** What a ChartWorld S-63 delivery looks like unpacked: fictional cell ids, no chart content. */
function chartworldArchive(kind: 'exchange' | 'permit'): Buffer {
    const zip = new AdmZip();
    if (kind === 'exchange') {
        zip.addFile('ZZ_ORDER_01/SERIAL.ENC', Buffer.from('fictional serial'));
        zip.addFile('ZZ_ORDER_01/ENC_ROOT/CATALOG.031', Buffer.from('fictional catalogue'));
        zip.addFile('ZZ_ORDER_01/ENC_ROOT/ZZ/ZZ5TEST1/1/0/ZZ5TEST1.000', Buffer.from('fictional encrypted cell'));
    } else {
        zip.addFile('PERMIT.TXT', Buffer.from(':DATE 20261011 00:00\n:VERSION 3\n:ENC\nZZ5TEST1fictional\n'));
    }
    return zip.toBuffer();
}

const OPENCPN_ONLY = 'ChartWorld S-63 charts open in OpenCPN on your Pi (Remote screen), not in Thalassa.';

for (const kind of ['exchange', 'permit'] as const) {
    test(`a ChartWorld S-63 ${kind} upload gets the OpenCPN answer, writes nothing and leaves no work dir (127)`, async (t) => {
        const h = await harness(t, async () => {
            throw new Error('an S-63 delivery must never reach the o-charts installer');
        });
        const response = await h.call(`/convert`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                'X-Filename': `ZZ_ORDER_01.${kind === 'exchange' ? 'S63.zip' : 'prm.zip'}`,
            },
            body: new Uint8Array(chartworldArchive(kind)),
        });
        assert.equal(response.status, 200);
        const { jobId } = (await response.json()) as { jobId: string };
        const finished = await poll(h.call, jobId, (job) => job.status === 'done' || job.status === 'error');
        assert.equal(finished.status, 'error');
        assert.equal(finished.error, OPENCPN_ONLY);
        // Its own code, so the Recent installs receipt says this and offers no retry.
        assert.equal(finished.errorCode, 's63-opencpn-only');
        assert.equal(finished.resultUrl, undefined);
        assert.equal(finished.persistedCellIds, undefined);
        // Nothing unpacked or kept: no inbox, no work dir, nothing in the store.
        await assert.rejects(fs.stat(CHARTWORLD_INBOX), { code: 'ENOENT' });
        await assert.rejects(fs.stat(path.join(os.tmpdir(), 'thalassa-enc-conversion', jobId)), { code: 'ENOENT' });
        const { cells } = await readChartIndex(process.env.ENC_CHART_DIR!);
        assert.equal(
            cells.some((cell) => cell.cellId === 'ZZ5TEST1'),
            false,
        );
    });
}

/** A sign-in page where a chart file should be: what an ePORTAL link hands a Pi with no session. */
const SIGN_IN_PAGE = Buffer.from('<!doctype html><html><body>Sign in (fictional)</body></html>');

test('a web page named as a ChartWorld delivery gets the OpenCPN answer, not "download it in your browser" (127)', async (t) => {
    const h = await harness(t);
    for (const [filename, opencpn] of [
        ['ZZ_ORDER_01.S63.ZIP', true],
        ['ZZ_ORDER_01.prm.zip', true],
        ['charts.zip', false],
    ] as const) {
        const response = await h.call(`/convert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': filename },
            body: new Uint8Array(SIGN_IN_PAGE),
        });
        const { jobId } = (await response.json()) as { jobId: string };
        const failed = await poll(h.call, jobId, (job) => job.status === 'error');
        if (opencpn) {
            assert.equal(failed.error, OPENCPN_ONLY, filename);
            assert.equal(failed.errorCode, 's63-opencpn-only', filename);
            await assert.rejects(fs.stat(path.join(os.tmpdir(), 'thalassa-enc-conversion', jobId)), {
                code: 'ENOENT',
            });
        } else {
            assert.match(String(failed.error), /signed in/, filename);
            assert.equal(failed.errorCode, undefined, filename);
        }
    }
});

test('a ChartWorld link is known by its host or its S-63 file names, and nothing else', () => {
    for (const url of [
        'https://eportal.chartworld.com/download/ZZ01',
        'https://www.chartworld.de/x',
        'https://chartworld.com',
    ])
        assert.equal(looksLikeChartworld(url, 'charts.zip'), true, url);
    for (const url of [
        'https://charts.example/chartworld',
        'https://notchartworld.com/x',
        'https://chartworld.com.example',
        'not a url',
        undefined,
    ])
        assert.equal(looksLikeChartworld(url, 'charts.zip'), false, String(url));
    assert.equal(looksLikeChartworld(undefined, 'ZZ_ORDER_01.S63.ZIP'), true);
    assert.equal(looksLikeChartworld(undefined, 'ZZ_ORDER_01.prm.zip'), true);
    assert.equal(looksLikeChartworld(undefined, 'US5ZZ01M.000'), false);
});

test('conversion failures surface actionable code and never become done-on-copy', async (t) => {
    const h = await harness(t, async () => {
        throw new ChartInstallError('ocharts-conversion-failed', 'Connect the registered dongle.');
    });
    const response = await h.call(`/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'charts.zip' },
        body: new Uint8Array(archive()),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    const failed = await poll(h.call, jobId, (job) => job.status === 'error');
    assert.equal(failed.errorCode, 'ocharts-conversion-failed');
    assert.equal(failed.resultUrl, undefined);
    assert.equal(failed.cellsDone, 0);
});

test('the open store serves the indexed version and redacts token-bearing legacy provenance', async (t) => {
    const h = await harness(t);
    const filename = path.join(root, 'cell.json');
    const bytes = JSON.stringify({ cells: [{ cellId: 'US5ZZ01M', edition: 5, marker: 'indexed-version' }] });
    await fs.writeFile(filename, bytes);
    const openStore = path.join(process.env.ENC_CHART_DIR!, 'open');
    await publishChartDelivery(openStore, [
        {
            filename,
            meta: {
                cellId: 'US5ZZ01M',
                sourceHO: 'US',
                edition: 5,
                issued: '2026-09-01',
                bbox: [-70.1, 41.1, -70, 41.2],
                featureCount: 1,
                sizeBytes: Buffer.byteLength(bytes),
                installedAt: new Date().toISOString(),
                source: 'url',
                sourceUrl: 'https://charts.example/private-token/archive.zip?signature=secret',
            },
        },
    ]);
    await fs.writeFile(path.join(openStore, 'cells', 'US5ZZ01M.json'), 'obsolete legacy bytes');
    const response = await h.call(`/installed/US5ZZ01M/data`);
    assert.equal(await response.text(), bytes);
    const installed = (await (await h.call(`/installed`)).json()) as {
        cells: { cellId: string; sourceUrl?: string; licence?: string }[];
    };
    const us = installed.cells.find((cell) => cell.cellId === 'US5ZZ01M');
    assert.equal(us?.sourceUrl, 'https://charts.example');
    assert.equal(us?.licence, 'open');
    assert.doesNotMatch(JSON.stringify(installed), /private-token|signature|secret/);
    assert.ok((await readChartIndex(openStore)).cells[0].contentSha256);
});

test('a protected cell left in the old plaintext store is never served from disk (127-C-d)', async (t) => {
    const h = await harness(t);
    const filename = path.join(root, 'old-protected.json');
    const bytes = JSON.stringify({ cells: [{ cellId: 'OC-99-ZZ0009', marker: 'old-plaintext' }] });
    await fs.writeFile(filename, bytes);
    await publishChartDelivery(process.env.ENC_CHART_DIR!, [
        {
            filename,
            meta: {
                cellId: 'OC-99-ZZ0009',
                sourceHO: 'ZZ',
                sourceCellId: 'ZZ5KESTR',
                edition: 1,
                issued: '2026-09-01',
                bbox: [-1.4, 50.7, -1.2, 50.8],
                featureCount: 1,
                sizeBytes: Buffer.byteLength(bytes),
                installedAt: new Date().toISOString(),
                source: 'pi-decrypt',
            },
        },
    ]);
    const data = await h.call(`/installed/OC-99-ZZ0009/data`);
    assert.equal(data.status, 404);
    assert.doesNotMatch(await data.text(), /old-plaintext/);
    const listed = (await (await h.call(`/installed`)).json()) as { cells: { cellId: string }[] };
    assert.equal(
        listed.cells.some((cell) => cell.cellId === 'OC-99-ZZ0009'),
        false,
    );
});

test('an unencrypted S-57 the classifier calls protected is not written: 415 not-open-chart', async (t) => {
    const h = await harness(t);
    const before = await fs.readdir(path.join(os.tmpdir(), 'thalassa-enc-conversion')).catch(() => [] as string[]);
    const upload = await h.call(`/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'ZZ5KESTR.000' },
        body: new Uint8Array(Buffer.from('fictional unencrypted cell')),
    });
    assert.equal(upload.status, 415);
    const body = (await upload.json()) as { code: string; error: string };
    assert.equal(body.code, 'not-open-chart');
    assert.equal(
        body.error,
        'Thalassa keeps only open charts (NOAA) as files on the Pi. Open other charts in OpenCPN.',
    );
    const after = await fs.readdir(path.join(os.tmpdir(), 'thalassa-enc-conversion')).catch(() => [] as string[]);
    assert.deepEqual(after.sort(), before.sort(), 'nothing staged');
    const pack = await h.call(`/install-public`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            region: 'zz-kestrel-harbour',
            geojson: {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        properties: { _layer: 'DEPARE' },
                        geometry: { type: 'Point', coordinates: [-1.3, 50.75] },
                    },
                ],
            },
        }),
    });
    assert.equal(pack.status, 415);
    assert.equal(((await pack.json()) as { code: string }).code, 'not-open-chart');
    const link = await h.call(`/install-from-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://charts.example/cells/ZZ5KESTR.000' }),
    });
    assert.equal(link.status, 415);
});

/**
 * An S-57 ZIP whose protected cells are corrupt (stored, one byte flipped):
 * unpacking any of them fails its CRC check, so a job that gets past the
 * unzip never unpacked one.
 */
function s57Zip(entries: { name: string; data: string; corrupt?: boolean }[]): Buffer {
    const zip = new AdmZip();
    for (const entry of entries) {
        zip.addFile(entry.name, Buffer.from(entry.data));
        zip.getEntry(entry.name)!.header.method = 0;
    }
    const buf = zip.toBuffer();
    for (const entry of entries.filter((e) => e.corrupt)) {
        const at = buf.indexOf(Buffer.from(entry.data));
        assert.ok(at > 0, `${entry.name} is stored`);
        buf[at] ^= 0x20;
    }
    return buf;
}

async function convertZip(t: TestContext, zip: Buffer) {
    const h = await harness(t);
    const response = await h.call(`/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'charts.zip' },
        body: new Uint8Array(zip),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    const job = await poll(h.call, jobId, (j) => j.status === 'error' || j.status === 'done');
    return { jobId, job };
}

test('a ZIP of protected unencrypted S-57 is refused from its names: nothing in it is unpacked (127-C-d)', async (t) => {
    const { jobId, job } = await convertZip(
        t,
        s57Zip([
            { name: 'ENC_ROOT/CATALOG.031', data: 'fictional catalogue' },
            { name: 'ENC_ROOT/ZZ5KESTR/1/0/ZZ5KESTR.000', data: 'fictional protected base cell', corrupt: true },
            { name: 'ENC_ROOT/ZZ5KESTR/1/1/ZZ5KESTR.001', data: 'fictional protected update', corrupt: true },
        ]),
    );
    assert.equal(job.status, 'error');
    assert.equal(job.errorCode, 'not-open-chart', String(job.error));
    assert.doesNotMatch(String(job.error), /unzip|CRC/i);
    const staged = await fs.readdir(path.join(os.tmpdir(), 'thalassa-enc-conversion')).catch(() => [] as string[]);
    assert.equal(staged.includes(jobId), false, 'the upload went with its work dir');
});

test('a mixed S-57 ZIP unpacks only its open (NOAA) cells, and the upload goes before they convert', async (t) => {
    // GDAL stand-ins that fail at once, so the run is the same with GDAL installed or not.
    const bin = await fs.mkdtemp(path.join(root, 'gdal-'));
    for (const tool of ['ogrinfo', 'ogr2ogr'])
        await fs.writeFile(path.join(bin, tool), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const PATH = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${PATH}`;
    t.after(() => {
        process.env.PATH = PATH;
    });
    const { jobId, job } = await convertZip(
        t,
        s57Zip([
            { name: 'ENC_ROOT/US5ZZ01M/3/0/US5ZZ01M.000', data: 'fictional open cell' },
            { name: 'ENC_ROOT/NZ5ZZ001/1/0/NZ5ZZ001.000', data: 'fictional protected cell', corrupt: true },
        ]),
    );
    // GDAL fails (nor is it a real cell): the one open cell is tried, and only it.
    assert.equal(job.status, 'error');
    assert.match(String(job.error), /All 1 cells in archive failed to convert/);
    assert.doesNotMatch(String(job.error), /unzip|CRC/i);
    const work = path.join(os.tmpdir(), 'thalassa-enc-conversion', jobId);
    await assert.rejects(fs.stat(path.join(work, 'charts.zip')), { code: 'ENOENT' }, 'the upload is gone');
    const unpacked = await fs.readdir(path.join(work, 'unzipped'), { recursive: true }).catch(() => [] as string[]);
    assert.equal(
        unpacked.some((name) => /NZ5ZZ001/.test(String(name))),
        false,
    );
    assert.ok(unpacked.some((name) => /US5ZZ01M\.000$/.test(String(name))));
});

test('malformed expected checksum is rejected before an upstream download starts', async (t) => {
    const h = await harness(t);
    const response = await h.call(`/install-from-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://charts.invalid/private-token', expectedSha256: 'incorrect' }),
    });
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /private-token/);
});
