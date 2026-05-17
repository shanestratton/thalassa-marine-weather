/**
 * One-shot import of sample ENC cells bundled with the dev build.
 *
 * The Pi-side `senc-extractor` writes canonical `EncConversionResult` JSON
 * files. For development we drop a small set into `public/enc-samples/` so
 * the dev server serves them at `/enc-samples/<cellId>.geojson` and the app
 * can fetch + `importCell()` them without an Apple Files-app sideload step.
 *
 * Guarded by a localStorage flag so we don't re-import on every app launch
 * after the user manually deletes a sample cell.
 *
 * Production builds skip this path entirely — it's a dev convenience to make
 * the Newport→Rivergate demo runnable without manual chart provisioning.
 */
import { Capacitor } from '@capacitor/core';
import { createLogger } from '../../utils/createLogger';
import { importCell, hasAnyCells } from './EncHazardService';
import type { EncConversionResult } from './types';

const log = createLogger('bootstrapEncSamples');
const FLAG_KEY = 'thalassa.enc.samplesImported.v1';

/**
 * Sample cells to fetch on first launch. Names match files in
 * `public/enc-samples/`. Add more entries to bundle additional regions.
 */
const SAMPLE_CELLS: string[] = ['OC-61-10ENB5'];

export async function bootstrapEncSamplesIfNeeded(): Promise<void> {
    // log.warn used throughout so the bootstrap is visible in Xcode console even
    // on a release build — createLogger.info is no-op'd in prod (see the
    // log.info() silenced in prod memory).
    try {
        if (localStorage.getItem(FLAG_KEY) === '1') {
            log.warn('bootstrap skipped — already ran (clear localStorage.thalassa.enc.samplesImported.v1 to retry)');
            return;
        }
        if (hasAnyCells()) {
            log.warn('bootstrap skipped — user already has cells');
            localStorage.setItem(FLAG_KEY, '1');
            return;
        }

        const platform = Capacitor.getPlatform();
        log.warn(`bootstrap starting on ${platform}, ${SAMPLE_CELLS.length} cells to fetch`);

        let imported = 0;
        for (const cellId of SAMPLE_CELLS) {
            const url = `/enc-samples/${cellId}.geojson`;
            try {
                log.warn(`  ${cellId}: fetching ${url}`);
                const res = await fetch(url);
                log.warn(`  ${cellId}: fetch returned HTTP ${res.status}`);
                if (!res.ok) {
                    log.warn(`  ${cellId}: NOT bundled (${res.status}) — skipping`);
                    continue;
                }
                const text = await res.text();
                log.warn(`  ${cellId}: got ${text.length} bytes, parsing JSON`);
                let blob: EncConversionResult;
                try {
                    blob = JSON.parse(text) as EncConversionResult;
                } catch (parseErr) {
                    log.warn(`  ${cellId}: JSON parse failed`, parseErr);
                    continue;
                }
                if (!blob.cellId || !blob.layers) {
                    log.warn(`  ${cellId}: malformed sample (no cellId/layers), skipping`);
                    continue;
                }
                await importCell(blob);
                imported += 1;
                log.warn(
                    `  ${cellId}: IMPORTED (${blob.sourceHO} edition ${blob.edition}, ${Object.keys(blob.layers).length} layers)`,
                );
            } catch (err) {
                log.warn(`  ${cellId}: import failed`, err);
            }
        }

        localStorage.setItem(FLAG_KEY, '1');
        log.warn(`bootstrap complete: ${imported}/${SAMPLE_CELLS.length} cells imported`);
    } catch (err) {
        log.warn('bootstrap unexpected error', err);
    }
}
