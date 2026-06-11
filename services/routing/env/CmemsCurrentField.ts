/**
 * CmemsCurrentField — CurrentField2D over the hourly CMEMS THCU grid the
 * map particle layer already decodes (Masterplan §5 / Phase 8 Lane A).
 *
 * ════════════════════════════════════════════════════════════════════
 * ETA-ONLY CONTRACT (masterplan §5 doctrine — enforced in review):
 *   Currents and leeway affect ETAs ONLY. Never feasibility. Never
 *   route geometry. The source is ≈1/12° CMEMS — it CANNOT resolve
 *   channel jets, eddies inside rivers, or anything bar-scale, so any
 *   consumer that prunes, gates, or re-ranks route GEOMETRY on these
 *   vectors is lying to the skipper with 'ESTIMATE'-class data. Use it
 *   to shift arrival times on an already-chosen line, nothing else.
 * ════════════════════════════════════════════════════════════════════
 *
 * Data path: scripts/cmems-currents-pipeline → GitHub Release → edge
 * proxy → services/weather/api/currentsGrid.fetchCurrentsGrid(), which
 * session-caches a WindGrid-shaped structure (u/v planes per hourly
 * step, rows NORTH→SOUTH, refTime = the model-run reference moment of
 * step 0). This module adds NO second fetch pipeline — the loader rides
 * that exact cache, so toggling the particles layer and asking for a
 * routing field cost one download between them.
 *
 * Temporal honesty (the WindFieldAdapter lesson): when the grid carries
 * an explicit `stepHours` axis it is authoritative — step index is NOT
 * assumed to equal forecast hour. Only when stepHours is absent (the
 * THCU pipeline today, genuinely hourly h00..hNN) does index == hour.
 * Outside coverage — space OR time — the answer is null, never a clamp:
 * a clamped current is a fabricated current.
 */

import type { WindGrid } from '../../weather/windField';
import type { CurrentField2D, Vector2 } from './EnvFields';
import { fetchCurrentsGrid } from '../../weather/api/currentsGrid';

const HOUR_MS = 3_600_000;

// ── Pure field construction ─────────────────────────────────────────

/**
 * Wrap an already-decoded THCU grid as a CurrentField2D.
 *
 * @param grid       The WindGrid-shaped currents grid (rows north→south,
 *                   cols west→east — the THCU pipeline layout; note this
 *                   is the OPPOSITE row order to what WindFieldAdapter
 *                   assumes for wind grids).
 * @param baseTimeMs Wall-clock ms of step 0 (= Date.parse(grid.refTime)
 *                   for THCU grids; the pipeline writes generated_at at
 *                   the moment h00 represents).
 *
 * Sampling: bilinear in space between the 4 surrounding cells, linear in
 * time between bracketing steps. Null outside the bbox, outside
 * [first step, last step], or where the planes hold non-finite values.
 */
export function currentFieldFromGrid(grid: WindGrid, baseTimeMs: number): CurrentField2D {
    // stepHours is authoritative for the temporal axis when present and
    // self-consistent; a length mismatch means the metadata is unreliable,
    // so fall back to hourly rather than misalign every sample.
    const stepHours = grid.stepHours && grid.stepHours.length === grid.totalHours ? grid.stepHours : null;
    const firstHr = stepHours ? stepHours[0] : 0;
    const lastHr = stepHours ? stepHours[stepHours.length - 1] : grid.totalHours - 1;

    return {
        provenance: 'CMEMS_HOURLY',
        currentAt(lat: number, lon: number, timeMs: number): Vector2 | null {
            // ── Temporal coverage + bracketing (no clamping past the ends) ──
            const offsetHr = (timeMs - baseTimeMs) / HOUR_MS;
            if (!isFinite(offsetHr) || offsetHr < firstHr || offsetHr > lastHr) return null;

            let h0: number;
            let h1: number;
            let tFrac: number;
            if (stepHours) {
                // Binary search: largest lo with stepHours[lo] <= offsetHr.
                let lo = 0;
                let hi = stepHours.length - 1;
                while (hi - lo > 1) {
                    const mid = (lo + hi) >> 1;
                    if (stepHours[mid] <= offsetHr) lo = mid;
                    else hi = mid;
                }
                const span = stepHours[hi] - stepHours[lo];
                h0 = lo;
                h1 = hi;
                tFrac = span > 0 ? (offsetHr - stepHours[lo]) / span : 0;
            } else {
                h0 = Math.min(Math.floor(offsetHr), grid.totalHours - 1);
                h1 = Math.min(h0 + 1, grid.totalHours - 1);
                tFrac = offsetHr - h0;
            }

            // ── Spatial coverage + bilinear weights ──
            // THCU rows run north→south: row 0 == grid.north. Degenerate
            // axes (north==south etc.) yield NaN and fall through to null.
            const rowF = ((grid.north - lat) / (grid.north - grid.south)) * (grid.height - 1);
            const colF = ((lon - grid.west) / (grid.east - grid.west)) * (grid.width - 1);
            if (!isFinite(rowF) || !isFinite(colF)) return null;
            if (rowF < 0 || rowF > grid.height - 1 || colF < 0 || colF > grid.width - 1) return null;

            const r0 = Math.floor(rowF);
            const r1 = Math.min(r0 + 1, grid.height - 1);
            const c0 = Math.floor(colF);
            const c1 = Math.min(c0 + 1, grid.width - 1);
            const rFrac = rowF - r0;
            const cFrac = colF - c0;

            // Sparse-assembly guard: currentsGrid indexes planes by the
            // manifest's hour value, so a gappy manifest leaves holes.
            const u0 = grid.u[h0];
            const v0 = grid.v[h0];
            const u1 = grid.u[h1];
            const v1 = grid.v[h1];
            if (!u0 || !v0 || !u1 || !v1) return null;

            const uA = bilinear(u0, r0, r1, c0, c1, rFrac, cFrac, grid.width);
            const vA = bilinear(v0, r0, r1, c0, c1, rFrac, cFrac, grid.width);
            const uB = bilinear(u1, r0, r1, c0, c1, rFrac, cFrac, grid.width);
            const vB = bilinear(v1, r0, r1, c0, c1, rFrac, cFrac, grid.width);

            const u = uA + (uB - uA) * tFrac;
            const v = vA + (vB - vA) * tFrac;
            // Fill values / masked cells decode as NaN in some CMEMS
            // products — surface them as "unknown", not as garbage drift.
            if (!isFinite(u) || !isFinite(v)) return null;

            return { u, v };
        },
    };
}

function bilinear(
    data: Float32Array,
    r0: number,
    r1: number,
    c0: number,
    c1: number,
    rFrac: number,
    cFrac: number,
    width: number,
): number {
    const v00 = data[r0 * width + c0];
    const v01 = data[r0 * width + c1];
    const v10 = data[r1 * width + c0];
    const v11 = data[r1 * width + c1];
    const top = v00 + (v01 - v00) * cFrac;
    const bot = v10 + (v11 - v10) * cFrac;
    return top + (bot - top) * rFrac;
}

// ── Loader over the existing fetch/cache path ───────────────────────

export interface LatLonBounds {
    north: number;
    south: number;
    west: number;
    east: number;
}

export interface TimeRangeMs {
    startMs: number;
    endMs: number;
}

/**
 * Fetch (or reuse the session-cached) THCU grid and return a
 * CurrentField2D covering the request — or null when one honestly can't
 * be built. Null is the OFFLINE / NO-DATA answer and consumers must
 * treat it as "currents unknown, ETAs un-adjusted", never as an error:
 *
 *   null when … the download fails (offline — currentsGrid already
 *               returns null cleanly), the grid has no parseable
 *               refTime (we refuse to guess a temporal origin), or the
 *               requested area/time doesn't intersect coverage at all.
 *
 * Partial overlap returns a field — the per-point null contract handles
 * legs that wander off the edge. Caching is whatever currentsGrid does
 * (session cache + inflight coalescing); this adds none of its own.
 *
 * @param area      Bbox or single point of interest (plain intervals; an
 *                  antimeridian-crossing bbox should be split by the
 *                  caller).
 * @param timeRange Departure→arrival span the consumer will sample.
 */
export async function getCurrentField(
    area: LatLonBounds | { lat: number; lon: number },
    timeRange: TimeRangeMs,
): Promise<CurrentField2D | null> {
    const grid = await fetchCurrentsGrid();
    if (!grid) return null;

    // Without the model-run reference time we cannot map wall-clock ms to
    // a step index honestly — refuse rather than assume "now == h00".
    const baseTimeMs = grid.refTime ? Date.parse(grid.refTime) : NaN;
    if (!isFinite(baseTimeMs)) return null;

    const stepHours = grid.stepHours && grid.stepHours.length === grid.totalHours ? grid.stepHours : null;
    const firstHr = stepHours ? stepHours[0] : 0;
    const lastHr = stepHours ? stepHours[stepHours.length - 1] : grid.totalHours - 1;
    const covStartMs = baseTimeMs + firstHr * HOUR_MS;
    const covEndMs = baseTimeMs + lastHr * HOUR_MS;
    if (timeRange.endMs < covStartMs || timeRange.startMs > covEndMs) return null;

    const bbox: LatLonBounds =
        'lat' in area ? { north: area.lat, south: area.lat, west: area.lon, east: area.lon } : area;
    const disjoint =
        bbox.south > grid.north || bbox.north < grid.south || bbox.west > grid.east || bbox.east < grid.west;
    if (disjoint) return null;

    return currentFieldFromGrid(grid, baseTimeMs);
}
