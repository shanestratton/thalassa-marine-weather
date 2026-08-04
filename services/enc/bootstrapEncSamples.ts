/**
 * One-shot import of bundled demo ENC cells.
 *
 * Ships **NOAA US-domain S-57 charts only** — they're US Federal data, public
 * domain, no EULA, free to redistribute. The previous AU bundle has been
 * removed: o-charts oeSENC charts are bound to the dongle that decrypted them
 * and their EULA prohibits redistribution, so they cannot ship in the app.
 *
 * For the user's purchased AU/NZ/EU coverage, the production path is `EncPiSync`
 * (separate service) — the iPhone pulls each user's own decrypted cells from
 * their own Bosun Pi over local wifi. Their license, their device.
 *
 * Public-beta/production builds do not run this bootstrap. It is available
 * only when a development, test, or dedicated demo build explicitly sets
 * VITE_ENABLE_ENC_DEMO_SAMPLES=true. Imported samples are tagged `demo`, and
 * EncCellMetadata excludes them from every live coverage/hazard consumer.
 */
import { Capacitor } from '@capacitor/core';
import { createLogger } from '../../utils/createLogger';
import { importCell } from './EncHazardService';
import type { EncConversionResult } from './types';

const log = createLogger('bootstrapEncSamples');
// Bumping the version forces the bootstrap to run again on next launch — used
// when we ship a new sample set or fix a previously-failed-silently regression.
const FLAG_KEY = 'thalassa.enc.samplesImported.v7';
let bootstrapPromise: Promise<void> | null = null;

/**
 * Sample cells to fetch on first launch. Names match files in
 * `public/enc-samples/`. Only US-domain NOAA cells appear here — they're
 * public domain and redistributable. AU/NZ/etc. coverage comes via EncPiSync
 * from the user's own Bosun Pi.
 *
 * Current set:
 *   - US5GA22M  NOAA Savannah River Savannah to Brier Creek
 *               1:20k harbour band, demonstrates DEPARE/LNDARE/COALNE/
 *               BCNLAT/BOYLAT/OBSTRN/WRECKS coverage for the inshore router.
 */
const SAMPLE_CELLS: string[] = ['US5GA22M'];

export function isEncDemoSampleOptedIn(): boolean {
    const explicit = String(import.meta.env?.VITE_ENABLE_ENC_DEMO_SAMPLES ?? 'false').toLowerCase() === 'true';
    const mode = String(import.meta.env?.MODE ?? 'production').toLowerCase();
    return explicit && (import.meta.env?.DEV === true || mode === 'test' || mode === 'demo');
}

export function bootstrapEncSamplesIfNeeded(): Promise<void> {
    if (!isEncDemoSampleOptedIn()) {
        log.info('demo ENC bootstrap disabled');
        return Promise.resolve();
    }
    // React StrictMode deliberately remounts effects in development. Keep the
    // import single-flight so both mounts share one fetch/parse/IndexedDB job
    // instead of racing a second 4.7 MB chart import before the flag is set.
    bootstrapPromise ??= runBootstrap();
    return bootstrapPromise;
}

async function runBootstrap(): Promise<void> {
    try {
        if (localStorage.getItem(FLAG_KEY) === '1') {
            log.info(`bootstrap skipped — already ran (clear localStorage.${FLAG_KEY} to retry)`);
            return;
        }

        // Always re-import our sample cells when a new bootstrap version fires —
        // older triangle-soup or earlier-edition cells get clobbered by importCell
        // (it overwrites by cellId). User-imported cells outside SAMPLE_CELLS are
        // never touched.
        const platform = Capacitor.getPlatform();
        log.info(`explicit demo bootstrap starting on ${platform} — ${SAMPLE_CELLS.length} sample cell(s)`);

        let imported = 0;
        const alreadyHave = 0;
        for (const cellId of SAMPLE_CELLS) {
            const url = `/enc-samples/${cellId}.geojson`;
            try {
                log.info(`  ${cellId}: fetching ${url}`);
                const res = await fetch(url);
                log.info(`  ${cellId}: fetch returned HTTP ${res.status}`);
                if (!res.ok) {
                    log.warn(`  ${cellId}: NOT bundled (${res.status}) — skipping`);
                    continue;
                }
                const text = await res.text();
                log.info(`  ${cellId}: got ${text.length} bytes, parsing JSON`);
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
                await importCell(blob, { usage: 'demo' });
                imported += 1;
                log.info(
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
            log.info(
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
