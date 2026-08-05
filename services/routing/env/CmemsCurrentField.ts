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
 * proxy → the shared schema-v2 trust boundary. Map display decodes one
 * selected frame. Public-beta routing is deliberately held: the publisher
 * has only global assets, so an automatic departure sweep would silently
 * download up to ~117 MB. `getCurrentField()` therefore performs no network
 * work and returns null until regional/tiled signed assets exist. The pure
 * sampler remains ready for a future bounded verified regional grid.
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
const HOUR_MS = 3_600_000;

/** Public-beta safety hold: global current cubes are not an acceptable implicit mobile download. */
export const CMEMS_CURRENT_ROUTING_BETA_ENABLED = false;

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

            // Fail closed at the coast. Publisher-masked land values are
            // deliberately encoded as zero, but zero is also a real current;
            // treating masked corners as observations would bias coastal ETA.
            // Exact edges/corners use only mathematically non-zero weights.
            if (
                !grid.landMask ||
                grid.landMask.length !== grid.width * grid.height ||
                interpolationTouchesLand(grid.landMask, r0, r1, c0, c1, rFrac, cFrac, grid.width)
            ) {
                return null;
            }

            // Sparse-sequence guard: only requested temporal brackets exist.
            const u0 = grid.u[h0];
            const v0 = grid.v[h0];
            const u1 = grid.u[h1];
            const v1 = grid.v[h1];
            const useA = 1 - tFrac > 0;
            const useB = tFrac > 0;
            let uA = 0;
            let vA = 0;
            if (useA) {
                if (!u0 || !v0) return null;
                uA = bilinear(u0, r0, r1, c0, c1, rFrac, cFrac, grid.width);
                vA = bilinear(v0, r0, r1, c0, c1, rFrac, cFrac, grid.width);
            }
            let uB = uA;
            let vB = vA;
            if (useB) {
                if (!u1 || !v1) return null;
                uB = bilinear(u1, r0, r1, c0, c1, rFrac, cFrac, grid.width);
                vB = bilinear(v1, r0, r1, c0, c1, rFrac, cFrac, grid.width);
            }

            const u = uA + (uB - uA) * tFrac;
            const v = vA + (vB - vA) * tFrac;
            // Fill values / masked cells decode as NaN in some CMEMS
            // products — surface them as "unknown", not as garbage drift.
            if (!isFinite(u) || !isFinite(v)) return null;

            return { u, v };
        },
    };
}

function interpolationTouchesLand(
    mask: Uint8Array,
    r0: number,
    r1: number,
    c0: number,
    c1: number,
    rFrac: number,
    cFrac: number,
    width: number,
): boolean {
    const corners = [
        { index: r0 * width + c0, weight: (1 - rFrac) * (1 - cFrac) },
        { index: r0 * width + c1, weight: (1 - rFrac) * cFrac },
        { index: r1 * width + c0, weight: rFrac * (1 - cFrac) },
        { index: r1 * width + c1, weight: rFrac * cFrac },
    ];
    return corners.some(({ index, weight }) => weight > 0 && mask[index] !== 0);
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

// ── Public-beta remote-loading boundary ─────────────────────────────

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
 * Public-beta no-data boundary. A future regional/tiled integrity scheme can
 * replace this implementation; until then, callers get an immediate null and
 * must label ETAs as current-unadjusted. The arguments remain in the API so
 * callers do not need another migration when a bounded source is available.
 */
export async function getCurrentField(
    area: LatLonBounds | { lat: number; lon: number },
    timeRange: TimeRangeMs,
    signal?: AbortSignal,
): Promise<CurrentField2D | null> {
    void area;
    void timeRange;
    void signal;
    if (!CMEMS_CURRENT_ROUTING_BETA_ENABLED) return null;
    return null;
}
