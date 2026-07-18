/**
 * extremesInterp — half-cosine tide height interpolation between extremes.
 *
 * Between an adjacent high/low pair the real tide closely follows a
 * half-cosine (the rule of twelfths is the same shape, discretised), so
 * interpolating cached HW/LW extremes yields a free, offline-capable
 * height curve — roughly ±0.3 m in semidiurnal regimes — without paying
 * WorldTides for dense station heights.
 *
 * Shared by:
 *   - services/weather/api/stormglass.ts — dense 30-min series for the
 *     dashboard tide graph
 *   - services/TideHeightService.ts — routing-grade heightAt() lookup
 *     (provenance 'EXTREMES_INTERP'; Phase 7 labels its windows "approx")
 *
 * Contract:
 *   - Lookups outside [first extreme, last extreme] return null — callers
 *     must not extrapolate guess-tides beyond the fetched window.
 *   - Queries exactly AT an extreme return that extreme's height verbatim
 *     (the blend formula can drift a ULP at frac 0/1).
 *   - Fewer than 2 extremes → every lookup returns null.
 *   - `type` (High/Low) is carried for provenance/labelling only; the
 *     maths blends ANY adjacent pair, so a missing type is fine.
 */

export interface TideExtremePoint {
    timeMs: number;
    heightM: number;
    type?: 'High' | 'Low';
}

/**
 * Half-cosine blend between two heights. frac ∈ [0, 1]:
 * 0 → h1, 0.5 → exact arithmetic midpoint, 1 → h2.
 */
export function halfCosineBlend(h1: number, h2: number, frac: number): number {
    return (h1 + h2) / 2 + ((h1 - h2) / 2) * Math.cos(frac * Math.PI);
}

/**
 * Build a reusable height lookup over an extremes array. Sorts a copy
 * (input order doesn't matter), then binary-searches per query — route
 * validation calls this hundreds of times per pass.
 */
export function buildExtremesLookup(extremes: readonly TideExtremePoint[]): (timeMs: number) => number | null {
    const sorted = [...extremes].sort((a, b) => a.timeMs - b.timeMs);

    return (timeMs: number): number | null => {
        if (sorted.length < 2) return null;
        if (timeMs < sorted[0].timeMs || timeMs > sorted[sorted.length - 1].timeMs) return null;

        // Binary search for the two extremes bracketing timeMs.
        let lo = 0;
        let hi = sorted.length - 1;
        while (lo < hi - 1) {
            const mid = (lo + hi) >> 1;
            if (sorted[mid].timeMs <= timeMs) lo = mid;
            else hi = mid;
        }
        const a = sorted[lo];
        const b = sorted[hi];
        // Exact extreme hits bypass the blend so HW/LW heights round-trip
        // bit-exact instead of picking up float error at frac 0/1.
        if (timeMs === a.timeMs) return a.heightM;
        if (timeMs === b.timeMs) return b.heightM;
        if (a.timeMs === b.timeMs) return a.heightM;
        // Alternation + inversion guard (cycle-6 re-audit #4, safety). Only when
        // BOTH endpoints carry a type — the routing path always does (WorldTides
        // 'High'/'Low'); the display-only stormglass path carries none and is
        // unaffected. A same-type pair (HW,HW — a dropped/aliased extreme) or an
        // inverted pair (a "High" below the adjacent "Low") is not a real tidal
        // swing: refuse to interpolate rather than emit a bogus curve whose
        // positive credit could clear a charted shallow. null → the caller falls
        // back to the static tide offset (chart datum, worst case), so a genuine
        // shoal stays flagged as a hazard.
        if (a.type && b.type) {
            if (a.type === b.type) return null;
            const high = a.type === 'High' ? a : b;
            const low = a.type === 'Low' ? a : b;
            if (high.heightM < low.heightM) return null; // physically inverted
        }
        return halfCosineBlend(a.heightM, b.heightM, (timeMs - a.timeMs) / (b.timeMs - a.timeMs));
    };
}

/**
 * One-shot lookup. Prefer buildExtremesLookup when querying the same
 * extremes repeatedly.
 */
export function heightFromExtremes(extremes: readonly TideExtremePoint[], timeMs: number): number | null {
    return buildExtremesLookup(extremes)(timeMs);
}
