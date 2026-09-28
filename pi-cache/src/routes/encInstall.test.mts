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

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'enc-route-test-'));
process.env.ENC_CHART_DIR = path.join(root, 'store');
const { createEncRoutes } = await import('./enc.js');
after(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

function harness(t: TestContext, installOCharts?: typeof installOChartsDelivery) {
    const app = express();
    app.use(express.json());
    app.use('/api/enc', createEncRoutes(undefined, { installOCharts }));
    const server = app.listen(0);
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/enc`;
    return { base };
}

function archive(): Buffer {
    const zip = new AdmZip();
    zip.addFile('set/FR466870.oesu', Buffer.from('encrypted fixture'));
    zip.addFile('set/oeuSENC-test-sgl1234.XML', Buffer.from('<keyList/>'));
    return zip.toBuffer();
}

async function poll(base: string, jobId: string, predicate: (job: Record<string, unknown>) => boolean) {
    for (let i = 0; i < 100; i++) {
        const job = (await (await fetch(`${base}/jobs/${jobId}`)).json()) as Record<string, unknown>;
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
    const h = harness(t, async (options) => {
        options.onProgress?.('Verifying converted charts', 0, 1);
        await gate;
        return {
            persistedCellIds: ['FR466870'],
            packageSummary: { new: 1, updated: 0, unchanged: 0, total: 1 },
            featureCount: 1,
            sourceArchiveId: 'fixture',
        };
    });
    const response = await fetch(`${h.base}/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'charts.zip' },
        body: new Uint8Array(archive()),
    });
    assert.equal(response.status, 200);
    const { jobId } = (await response.json()) as { jobId: string };
    const converting = await poll(h.base, jobId, (job) => job.status === 'converting');
    assert.equal(converting.resultUrl, undefined);
    assert.equal((await fetch(`${h.base}/jobs/${jobId}`, { method: 'DELETE' })).status, 409);
    complete();
    const ready = await poll(h.base, jobId, (job) => job.status === 'done');
    assert.equal(ready.resultKind, 'installed');
    assert.equal(ready.resultUrl, undefined);
    assert.deepEqual(ready.persistedCellIds, ['FR466870']);
    assert.deepEqual(ready.packageSummary, { new: 1, updated: 0, unchanged: 0, total: 1 });
    const recent = (await (await fetch(`${h.base}/jobs`)).json()) as { jobs: Record<string, unknown>[] };
    assert.ok(recent.jobs.some((job) => job.id === jobId && job.resultKind === 'installed'));
});

test('conversion failures surface actionable code and never become done-on-copy', async (t) => {
    const h = harness(t, async () => {
        throw new ChartInstallError('ocharts-conversion-failed', 'Connect the registered dongle.');
    });
    const response = await fetch(`${h.base}/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'charts.zip' },
        body: new Uint8Array(archive()),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    const failed = await poll(h.base, jobId, (job) => job.status === 'error');
    assert.equal(failed.errorCode, 'ocharts-conversion-failed');
    assert.equal(failed.resultUrl, undefined);
    assert.equal(failed.cellsDone, 0);
});

test('installed endpoint serves the indexed version and redacts token-bearing legacy provenance', async (t) => {
    const h = harness(t);
    const filename = path.join(root, 'cell.json');
    const bytes = JSON.stringify({ cells: [{ cellId: 'FR466870', edition: 5, marker: 'indexed-version' }] });
    await fs.writeFile(filename, bytes);
    await publishChartDelivery(process.env.ENC_CHART_DIR!, [
        {
            filename,
            meta: {
                cellId: 'FR466870',
                sourceHO: 'FR',
                edition: 5,
                issued: '2026-09-01',
                bbox: [165, -23, 167, -21],
                featureCount: 1,
                sizeBytes: Buffer.byteLength(bytes),
                installedAt: new Date().toISOString(),
                source: 'url',
                sourceUrl: 'https://charts.example/private-token/archive.zip?signature=secret',
            },
        },
    ]);
    await fs.writeFile(path.join(process.env.ENC_CHART_DIR!, 'cells', 'FR466870.json'), 'obsolete legacy bytes');
    const response = await fetch(`${h.base}/installed/FR466870/data`);
    assert.equal(await response.text(), bytes);
    const installed = (await (await fetch(`${h.base}/installed`)).json()) as { cells: { sourceUrl?: string }[] };
    assert.equal(installed.cells[0].sourceUrl, 'https://charts.example');
    assert.doesNotMatch(JSON.stringify(installed), /private-token|signature|secret/);
    assert.ok((await readChartIndex(process.env.ENC_CHART_DIR!)).cells[0].contentSha256);
});

test('malformed expected checksum is rejected before an upstream download starts', async (t) => {
    const h = harness(t);
    const response = await fetch(`${h.base}/install-from-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://charts.invalid/private-token', expectedSha256: 'incorrect' }),
    });
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /private-token/);
});
