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
    try {
        if (localStorage.getItem(FLAG_KEY) === '1') return;
        // Don't clobber a real user's existing fleet of cells.
        if (hasAnyCells()) {
            localStorage.setItem(FLAG_KEY, '1');
            return;
        }

        // Sample files only ship via the Vite dev server (or whatever public/
        // assets the prod build includes). Skip cleanly on native if not bundled.
        const platform = Capacitor.getPlatform();
        log.info(`bootstrap starting on ${platform}, ${SAMPLE_CELLS.length} cells`);

        let imported = 0;
        for (const cellId of SAMPLE_CELLS) {
            try {
                const res = await fetch(`/enc-samples/${cellId}.geojson`);
                if (!res.ok) {
                    log.info(`  ${cellId}: not bundled (${res.status}), skipping`);
                    continue;
                }
                const blob = (await res.json()) as EncConversionResult;
                if (!blob.cellId || !blob.layers) {
                    log.warn(`  ${cellId}: malformed sample, skipping`);
                    continue;
                }
                await importCell(blob);
                imported += 1;
                log.info(
                    `  ${cellId}: imported (${blob.sourceHO}, edition ${blob.edition}, ${Object.keys(blob.layers).length} layers)`,
                );
            } catch (err) {
                log.warn(`  ${cellId}: import failed`, err);
            }
        }

        // Set the flag regardless of how many imported — failed imports
        // shouldn't cause an infinite retry loop on every launch.
        localStorage.setItem(FLAG_KEY, '1');
        log.info(`bootstrap complete: ${imported}/${SAMPLE_CELLS.length} cells imported`);
    } catch (err) {
        log.warn('bootstrap unexpected error', err);
    }
}
