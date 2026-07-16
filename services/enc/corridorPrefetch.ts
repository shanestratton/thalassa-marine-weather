/**
 * corridorPrefetch — pull the ENC cells for a traced route's corridor in the
 * background, while the skipper is still dropping pins.
 *
 * Shane 2026-07-16: the app knows the start and finish the moment two pins
 * exist — use that. As the trace grows, quietly ensure every registered cell
 * covering the route's padded bbox has its blob on the device, via the same
 * ladder route-time loading uses (device → Pi → cloud, EncCellStore
 * .loadCellGeoJSON). By the time ⚡ Auto route / grading / the report needs
 * charts, they're already local — and offshore with only the Pi, routing no
 * longer starves.
 *
 * The bbox padding mirrors the inshore engine's request box
 * (max(span×0.5, 0.08°)) so the prefetched set covers anything the engine
 * will ask for on any leg. Runs are single-flight, keyed by the cell-set
 * they'd fetch, and capped per run — a monster passage fills over several
 * runs (each pin edit re-triggers) instead of hammering the Pi/bucket once.
 */

import { cellsForBBox } from './EncCellMetadata';
import { hasCellGeoJSON, loadCellGeoJSON } from './EncCellStore';
import { registerCloudCells } from './cloudCellSync';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('corridorPrefetch');

/** Cells pulled per run — bounds one run's network/disk cost; later edits
 *  (or the next debounce) continue the fill. */
const MAX_CELLS_PER_RUN = 12;

export interface CorridorPrefetchResult {
    /** Registered cells covering the corridor that were missing locally. */
    needed: number;
    /** How many of those this run actually pulled (Pi or cloud). */
    fetched: number;
}

let inflight: Promise<CorridorPrefetchResult> | null = null;
let lastKey = '';

/** The engine's request-box padding, over the whole pin set. Exported for the
 *  test that pins it to the inshore engine's formula (max(span×0.5, 0.08°)). */
export function corridorBBox(pins: ReadonlyArray<{ lat: number; lon: number }>): [number, number, number, number] {
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    for (const p of pins) {
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lon < minLon) minLon = p.lon;
        if (p.lon > maxLon) maxLon = p.lon;
    }
    const maxSpan = Math.max(maxLat - minLat, maxLon - minLon);
    const pad = Math.max(maxSpan * 0.5, 0.08);
    return [minLon - pad, minLat - pad, maxLon + pad, maxLat + pad];
}

/**
 * Ensure the corridor's cells are local. Never rejects; safe to fire-and-
 * forget on every (debounced) pin edit. Re-entrant calls while a run is in
 * flight return that run; a call whose missing-set matches the last completed
 * run's key no-ops (nothing new to do until the route or the registry moves).
 */
export async function prefetchCorridorCells(
    pins: ReadonlyArray<{ lat: number; lon: number }>,
): Promise<CorridorPrefetchResult> {
    if (pins.length < 2) return { needed: 0, fetched: 0 };
    if (inflight) return inflight;
    inflight = (async () => {
        try {
            // Make sure cloud-manifest cells are registered so their bboxes are
            // known (memoized — one manifest fetch per session). Signed-out /
            // offline quietly registers nothing; Pi-synced cells are already in.
            await registerCloudCells().catch(() => 0);
            const bbox = corridorBBox(pins);
            const covering = cellsForBBox(bbox);
            const missing: string[] = [];
            for (const c of covering) {
                if (!(await hasCellGeoJSON(c.id))) missing.push(c.id);
            }
            if (missing.length === 0) {
                lastKey = '';
                return { needed: 0, fetched: 0 };
            }
            const key = missing.join(',');
            if (key === lastKey) return { needed: missing.length, fetched: 0 }; // already tried this exact set
            let fetched = 0;
            for (const id of missing.slice(0, MAX_CELLS_PER_RUN)) {
                // The ladder does the work: Pi first (on the boat), cloud else.
                if (await loadCellGeoJSON(id)) fetched++;
            }
            // Only latch the key when the whole set was attempted and nothing
            // landed — otherwise leave it open so the next edit continues/retries.
            lastKey = fetched === 0 && missing.length <= MAX_CELLS_PER_RUN ? key : '';
            if (fetched > 0)
                log.warn(`corridor prefetch: ${fetched}/${missing.length} cell(s) pulled for the route area`);
            return { needed: missing.length, fetched };
        } catch (err) {
            log.warn(`corridor prefetch failed: ${err instanceof Error ? err.message : String(err)}`);
            return { needed: 0, fetched: 0 };
        } finally {
            inflight = null;
        }
    })();
    return inflight;
}
