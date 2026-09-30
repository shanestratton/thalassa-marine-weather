import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSourceReconvertStatus, startSourceReconvert } from './encSourceReconvert.js';

// Own file on purpose: the pass runs once per start (module state).

test('next to an older encWatcher.js / oChartsInstaller.js the pass is skipped, never a link failure', async () => {
    const warnings: string[] = [];
    let conversions = 0;
    // What the namespace imports look like when those files come from a build
    // before this change: the exports are simply missing.
    await startSourceReconvert({
        chartStoreDir: '/nonexistent/enc-charts',
        watcherModule: { startEncWatcher: () => {} },
        installerModule: { installOChartsDelivery: () => {} },
        runExtractor: async () => {
            conversions++;
        },
        logger: { log: () => {}, warn: (message: string) => warnings.push(message) },
    });
    const status = getSourceReconvertStatus();
    assert.equal(status.state, 'done');
    assert.equal(status.code, 'reconvert-unavailable');
    assert.equal(conversions, 0);
    assert.equal(warnings.length, 1);
    assert.match(
        warnings[0],
        /^\[encReconvert\] reconvert-unavailable: encWatcher\.whenInitialReconcileSettled, oChartsInstaller\.reconvertRetainedOChartsSources missing/,
    );
});
