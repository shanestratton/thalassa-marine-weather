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
import { crumb } from '../../utils/flightRecorder';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('corridorPrefetch');

/**
 * The span above which the padded-bbox prefetch stops being a corridor.
 *
 * The pad formula below mirrors the inshore engine's request box — but the
 * ENGINE refuses any route beyond MAX_INSHORE_NM (50 NM, ~0.83°), so its
 * version of the formula is bounded by construction. This module copied the
 * formula WITHOUT the ceiling. On a passage-scale trace the pad grows with the
 * route: Moreton Bay to the start of the GBR spans ~4°, pads by ~2° a side,
 * and the "corridor" becomes an ~8°×5° box over the densest cell region on
 * the coast. Every pin edit then hydrated another 12 reef cells, every import
 * bumped the registry, every bump re-ran a ~27 MB display merge — the storm
 * under the Plan-page deaths at the southern reef (Shane, 2026-08-22:
 * "continually crashes around the beginning of the GBR", phone AND web).
 *
 * At or below this span the engine can genuinely consume the whole padded box,
 * so behaviour is byte-identical to the original. Above it, no consumer exists
 * for the corners: auto-route refuses the route outright and leg grading works
 * in ≤40 km windows around the line — so we fetch cells NEAR THE LINE instead.
 */
export const ENGINE_MAX_SPAN_DEG = 0.84;

/** Segment-corridor half-width for passage-scale traces: the engine's own
 *  maximum legal pad (0.84° span × 0.5 = 0.42°), so a cell the engine could
 *  ever legally request for any sub-50NM leg of the trace is still inside. */
export const CORRIDOR_PAD_DEG = 0.42;

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

/** Minimum degree-distance from a bbox to a polyline segment set (approx —
 *  treats degrees as planar, which over-includes slightly at these spans;
 *  over-inclusion is the safe direction for a prefetch filter). */
function bboxNearPolyline(
    bbox: [number, number, number, number],
    pins: ReadonlyArray<{ lat: number; lon: number }>,
    padDeg: number,
): boolean {
    const [w, s, e, n] = [bbox[0] - padDeg, bbox[1] - padDeg, bbox[2] + padDeg, bbox[3] + padDeg];
    // A segment intersects the padded bbox iff either endpoint is inside, or
    // the segment crosses it. Endpoint-inside covers the overwhelmingly common
    // case; the crossing test catches a long leg that vaults a small cell.
    const inside = (p: { lat: number; lon: number }): boolean =>
        p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n;
    for (let i = 0; i + 1 < pins.length; i++) {
        const a = pins[i];
        const b = pins[i + 1];
        if (inside(a) || inside(b)) return true;
        // Conservative segment/rect overlap: reject only when the whole
        // segment lies strictly on one side of the rect.
        if (Math.max(a.lon, b.lon) < w || Math.min(a.lon, b.lon) > e) continue;
        if (Math.max(a.lat, b.lat) < s || Math.min(a.lat, b.lat) > n) continue;
        return true;
    }
    return false;
}

/**
 * The cells a prefetch run should pull for this pin set.
 *
 * Exported pure so the passage-scale trim is testable: short traces get the
 * engine-parity padded bbox untouched; long traces keep only cells near the
 * traced line, because nothing can consume the rest (see ENGINE_MAX_SPAN_DEG).
 */
export function selectCorridorCells<T extends { bbox: [number, number, number, number] }>(
    pins: ReadonlyArray<{ lat: number; lon: number }>,
    cellsInBBox: (bbox: [number, number, number, number]) => T[],
): T[] {
    const bbox = corridorBBox(pins);
    let minLat = Infinity,
        maxLat = -Infinity,
        minLon = Infinity,
        maxLon = -Infinity;
    for (const p of pins) {
        minLat = Math.min(minLat, p.lat);
        maxLat = Math.max(maxLat, p.lat);
        minLon = Math.min(minLon, p.lon);
        maxLon = Math.max(maxLon, p.lon);
    }
    const span = Math.max(maxLat - minLat, maxLon - minLon);
    const covering = cellsInBBox(bbox);
    if (span <= ENGINE_MAX_SPAN_DEG) return covering;
    return covering.filter((c) => bboxNearPolyline(c.bbox, pins, CORRIDOR_PAD_DEG));
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
            const covering = selectCorridorCells(pins, cellsForBBox);
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
            // Crumb the population, not just the pulls: the Plan-page fatal
            // trails need to SHOW when a trace's missing-cell set is huge.
            crumb('corridor:prefetch', `${missing.length}missing`);
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
