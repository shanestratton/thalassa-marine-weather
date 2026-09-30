import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSourceReconvertStatus, startSourceReconvert, stopSourceReconvert } from './encSourceReconvert.js';

// Own file on purpose: the pass runs once per start (module state), and each
// test file is its own process.

test('a service stop ends the pass promptly and nothing is converted', async () => {
    const warnings: string[] = [];
    let conversions = 0;
    let leases = 0;
    const run = startSourceReconvert({
        chartStoreDir: '/nonexistent/enc-charts',
        extractorDir: '/nonexistent/extractor',
        workRoot: '/nonexistent/work',
        // The watcher's startup reconcile is still running when the stop comes.
        waitForReconcile: () => new Promise<void>(() => {}),
        acquireLease: async () => {
            leases++;
            return { release: () => {} };
        },
        runExtractor: async () => {
            conversions++;
        },
        logger: { log: () => {}, warn: (message: string) => warnings.push(message) },
    });
    assert.equal(getSourceReconvertStatus().state, 'waiting');
    const startedAt = Date.now();
    assert.equal(await stopSourceReconvert(5_000), 'stopped');
    assert.ok(Date.now() - startedAt < 1_000);
    await run;
    const status = getSourceReconvertStatus();
    assert.equal(status.state, 'stopped');
    assert.deepEqual(status.outcomes, []);
    assert.equal(conversions, 0);
    assert.equal(leases, 0);
    assert.deepEqual(warnings, []);
    // A second stop (SIGINT then SIGTERM) finds it already over.
    assert.equal(await stopSourceReconvert(5_000), 'stopped');
});
