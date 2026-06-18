/**
 * segmentRoute (PHASE 1) — docs/THREE_TIER_ROUTING.md §2.
 * Classifies the REAL navigable polyline into ordered tier spans on synthetic
 * grids (deterministic): tier-3 = marked/preferred channel, tier-2 = deep
 * marks-free, unknown = no-evidence → refuse on a long run.
 */
import { describe, it, expect } from 'vitest';
import { segmentRoute, type TierSpan } from '../../services/routing/segmentRoute';
import type { NavGrid } from '../../services/inshoreRouterEngine';
import type { LateralMark } from '../../services/fairlead';
import { isRefusal, type LatLon } from '../../services/routing/legContract';

const MIN_LAT = -27.3;
const MIN_LON = 153.0;
const RES_M = 50;
const dLat = RES_M / 110_540;
const dLon = RES_M / (111_320 * Math.cos((MIN_LAT * Math.PI) / 180));
const WIDTH = 4;
const HEIGHT = 70;

/** Build an N-S corridor grid (all 10 m deep) with a per-y-band classifier
 *  hook for preferred (channel) + unvouched (no-evidence). */
function makeGrid(
    opts: {
        preferredY?: (y: number) => boolean;
        unvouchedY?: (y: number) => boolean;
        injectedY?: (y: number) => boolean;
    } = {},
): NavGrid {
    const n = WIDTH * HEIGHT;
    const cells = new Float32Array(n).fill(10);
    const preferred = new Uint8Array(n);
    const unvouched = new Uint8Array(n);
    const injectedCanal = new Uint8Array(n);
    let anyInjected = false;
    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            const i = y * WIDTH + x;
            if (opts.preferredY?.(y)) preferred[i] = 1;
            if (opts.injectedY?.(y)) {
                injectedCanal[i] = 1;
                anyInjected = true;
            }
            if (opts.unvouchedY?.(y)) {
                unvouched[i] = 1;
                cells[i] = 0; // UNKNOWN_OPEN — unvouched is only meaningful paired with this
            }
        }
    }
    return {
        width: WIDTH,
        height: HEIGHT,
        minLon: MIN_LON,
        minLat: MIN_LAT,
        dLon,
        dLat,
        cells,
        preferred,
        unvouched,
        // Only attach the mask when a test asks for it, so the default grid is
        // byte-identical to before (field undefined ⇒ injected term always false).
        ...(anyInjected ? { injectedCanal } : {}),
    };
}

/** A N-S polyline down the corridor centre, one vertex per cell row. */
function corridorLine(yLo = 1, yHi = HEIGHT - 2): LatLon[] {
    const lon = MIN_LON + 1.5 * dLon;
    const out: LatLon[] = [];
    for (let y = yLo; y <= yHi; y++) out.push([lon, MIN_LAT + (y + 0.5) * dLat]);
    return out;
}

const tiers = (spans: TierSpan[]): number[] => spans.map((s) => s.tier);

describe('segmentRoute', () => {
    it('a channel → deep bay → channel route segments [3, 2, 3]', () => {
        // south third (y 1–22) channel, middle (23–46) deep bay, north (47–68) channel
        const grid = makeGrid({ preferredY: (y) => y <= 22 || y >= 47 });
        const r = segmentRoute(corridorLine(), grid, [], 2.4, 0.2, 0.5);
        expect(isRefusal(r)).toBe(false);
        if (!isRefusal(r)) {
            expect(tiers(r)).toEqual([3, 2, 3]);
            // boundary kinds: leaving a channel = last-lead, entering = channel-mouth
            expect(r[0].exit.kind).toBe('last-lead');
            expect(r[1].exit.kind).toBe('channel-mouth');
            expect(r[0].entry.kind).toBe('origin');
            expect(r[2].exit.kind).toBe('dest');
            // adjacent spans SHARE the seam vertex (so the Gluer can join them) —
            // span r's entry IS span r-1's exit, same vertex.
            expect(r[0].exit.at).toBe(r[1].entry.at);
            expect(r[1].exit.at).toBe(r[2].entry.at);
            expect(r[0].toIdx).toBe(r[1].fromIdx);
            expect(r[1].toIdx).toBe(r[2].fromIdx);
        }
    });

    it('an all-deep marks-free crossing is a single tier-2 span', () => {
        const grid = makeGrid(); // no preferred, no marks, all 10 m
        const r = segmentRoute(corridorLine(), grid, [], 2.4, 0.2, 0.5);
        expect(isRefusal(r)).toBe(false);
        if (!isRefusal(r)) expect(tiers(r)).toEqual([2]);
    });

    it('an injected-canal vertex classifies tier-3 even when deep + marks-free', () => {
        // South third flagged as INJECTED canal water (Mapbox-water fill), all 10 m
        // deep, NO preferred, NO marks. Without the injectedCanal flag this is the
        // [2] tier-2 passthrough above — the exact wall-hug bug. With it, the south
        // becomes tier-3 (reaches the canal router) while the deep north stays
        // tier-2 (the open bay is NOT flagged → constraint: bay stays tier-2).
        const grid = makeGrid({ injectedY: (y) => y <= 22 });
        const r = segmentRoute(corridorLine(), grid, [], 2.4, 0.2, 0.5);
        expect(isRefusal(r)).toBe(false);
        if (!isRefusal(r)) expect(tiers(r)).toEqual([3, 2]);
    });

    it('marks (not just preferred) make a span tier-3', () => {
        const grid = makeGrid(); // no preferred anywhere
        // a pair of lateral marks beside the SOUTH third of the line
        const lon = MIN_LON + 1.5 * dLon;
        const marks: LateralMark[] = [];
        for (let y = 2; y <= 20; y += 4) {
            const lat = MIN_LAT + (y + 0.5) * dLat;
            marks.push({ lat, lon: lon - 0.0005, side: 'port', key: 'X', seq: y, name: `X${y}` });
            marks.push({ lat, lon: lon + 0.0005, side: 'stbd', key: 'X', seq: y, name: `X${y}` });
        }
        const r = segmentRoute(corridorLine(), grid, marks, 2.4, 0.2, 0.5);
        expect(isRefusal(r)).toBe(false);
        if (!isRefusal(r)) expect(tiers(r)).toEqual([3, 2]); // south near marks, north deep
    });

    it('a short tier flap is absorbed (hysteresis): 1 deep cell amid a channel stays [3]', () => {
        // channel everywhere except ONE cell (y=35) that reads non-preferred deep
        const grid = makeGrid({ preferredY: (y) => y !== 35 });
        const r = segmentRoute(corridorLine(), grid, [], 2.4, 0.2, 0.5);
        expect(isRefusal(r)).toBe(false);
        if (!isRefusal(r)) expect(tiers(r)).toEqual([3]); // the single deep cell absorbed
    });

    it('a long uncharted (no-evidence) run refuses before any router runs', () => {
        // middle third unvouched (UNKNOWN_OPEN) over > UNCHARTED_MAX_RUN_M (1852 m)
        const grid = makeGrid({ unvouchedY: (y) => y >= 20 && y <= 60 }); // ~40 cells ≈ 2 km
        const r = segmentRoute(corridorLine(), grid, [], 2.4, 0.2, 0.5);
        expect(isRefusal(r)).toBe(true);
        if (isRefusal(r)) expect(r.reason).toBe('uncharted-run');
    });
});
