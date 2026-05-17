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
// Bumping the version forces the bootstrap to run again on next launch — used
// when we ship a new sample set or fix a previously-failed-silently regression.
const FLAG_KEY = 'thalassa.enc.samplesImported.v3';

/**
 * Sample cells to fetch on first launch. Names match files in
 * `public/enc-samples/`. Add more entries to bundle additional regions.
 *
 * Current set: Newport Marina → Rivergate Marina via the Brisbane River.
 *   - OC-61-10RCS5  Newport Waterways (harbour-band detail, lat -27.22..-27.17)
 *   - OC-61-10ENB5  Brisbane River + south Moreton Bay (lat -27.48..-27.09)
 *   - OC-61-20ENB5  N Moreton Bay (lat -27.10..-26.71)
 *   - OC-61-351824  SE QLD overview (-28..-27, 153..154) — fallback at low zoom
 */
const SAMPLE_CELLS: string[] = ['OC-61-10RCS5', 'OC-61-10ENB5', 'OC-61-20ENB5', 'OC-61-351824'];

export async function bootstrapEncSamplesIfNeeded(): Promise<void> {
    // log.warn used throughout so the bootstrap is visible in Xcode console even
    // on a release build — createLogger.info is no-op'd in prod (see the
    // log.info() silenced in prod memory).
    try {
        if (localStorage.getItem(FLAG_KEY) === '1') {
            log.warn(`bootstrap skipped — already ran (clear localStorage.${FLAG_KEY} to retry)`);
            return;
        }
        if (hasAnyCells()) {
            // Diagnostic dump — once we're seeing the right cells in the FAB
            // this branch is safe to silence, but right now we need to know
            // *which* cell(s) the metadata store has registered.
            try {
                const { listCells } = await import('./EncCellMetadata');
                const cells = listCells();
                log.warn(
                    `bootstrap skipped — ${cells.length} cell(s) already imported: ${cells
                        .map((c) => `${c.id}(${c.sourceHO},ed${c.edition})`)
                        .join(', ')}`,
                );
            } catch {
                log.warn('bootstrap skipped — user already has cells (could not enumerate)');
            }
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

        // Only latch the flag on success — a failed first attempt (e.g. file
        // not yet bundled into the build) shouldn't lock subsequent launches
        // out of retrying.
        if (imported > 0) {
            localStorage.setItem(FLAG_KEY, '1');
            log.warn(`bootstrap complete: ${imported}/${SAMPLE_CELLS.length} cells imported, flag set`);
        } else {
            log.warn(
                `bootstrap complete: 0/${SAMPLE_CELLS.length} cells imported — flag NOT set, will retry on next launch`,
            );
        }
    } catch (err) {
        log.warn('bootstrap unexpected error', err);
    }
}
