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
import { importCell } from './EncHazardService';
import { listCells } from './EncCellMetadata';
import type { EncConversionResult } from './types';

const log = createLogger('bootstrapEncSamples');
// Bumping the version forces the bootstrap to run again on next launch — used
// when we ship a new sample set or fix a previously-failed-silently regression.
const FLAG_KEY = 'thalassa.enc.samplesImported.v6';

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

        // Always re-import our sample cells when a new bootstrap version fires —
        // older triangle-soup or earlier-edition cells get clobbered by importCell
        // (it overwrites by cellId). User-imported cells outside SAMPLE_CELLS are
        // never touched.
        const existing = new Set(listCells().map((c) => c.id));
        const platform = Capacitor.getPlatform();
        log.warn(
            `bootstrap starting on ${platform} — ${SAMPLE_CELLS.length} sample cells, ${existing.size} cells in store (will overwrite any matching sample IDs)`,
        );

        let imported = 0;
        const alreadyHave = 0;
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

        // Latch the flag only when every sample is accounted for (either pre-
        // existing or freshly imported). A partial run leaves the flag unset
        // so subsequent launches keep trying.
        const covered = imported + alreadyHave;
        if (covered === SAMPLE_CELLS.length) {
            localStorage.setItem(FLAG_KEY, '1');
            log.warn(
                `bootstrap complete: ${imported} imported / ${alreadyHave} pre-existing / ${SAMPLE_CELLS.length} total, flag set`,
            );
        } else {
            log.warn(
                `bootstrap complete: ${imported} imported / ${alreadyHave} pre-existing / ${SAMPLE_CELLS.length} expected — flag NOT set, will retry`,
            );
        }
    } catch (err) {
        log.warn('bootstrap unexpected error', err);
    }
}
