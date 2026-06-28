/**
 * segmentRoute (PHASE 1) — docs/THREE_TIER_ROUTING.md §2.
 * Classifies the REAL navigable polyline into ordered tier spans on synthetic
 * grids (deterministic): tier-1 = canal/marina, tier-2 = marked/preferred channel,
 * tier-3 = deep inshore bay,
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
    it('a channel → deep bay → channel route segments [2, 3, 2]', () => {
        // south third (y 1–22) channel, middle (23–46) deep bay, north (47–68) channel
        const grid = makeGrid({ preferredY: (y) => y <= 22 || y >= 47 });
        const r = segmentRoute(corridorLine(), grid, [], 2.4, 0.2, 0.5);
        expect(isRefusal(r)).toBe(false);
        if (!isRefusal(r)) {
            expect(tiers(r)).toEqual([2, 3, 2]);
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

    it('an all-deep marks-free crossing is a single tier-3 span', () => {
        const grid = makeGrid(); // no preferred, no marks, all 10 m
        const r = segmentRoute(corridorLine(), grid, [], 2.4, 0.2, 0.5);
        expect(isRefusal(r)).toBe(false);
        if (!isRefusal(r)) expect(tiers(r)).toEqual([3]);
    });

    it('an injected-canal vertex classifies tier-1 even when deep + marks-free', () => {
        // South third flagged as INJECTED canal water (Mapbox-water fill), all 10 m
        // deep, NO preferred, NO marks. Without the injectedCanal flag this is the
        // [3] tier-3 passthrough above — the exact wall-hug bug. With it, the south
        // becomes tier-1 (reaches the canal router) while the deep north stays
        // tier-3 (the open bay is NOT flagged → constraint: bay stays tier-3).
        const grid = makeGrid({ injectedY: (y) => y <= 22 });
        const r = segmentRoute(corridorLine(), grid, [], 2.4, 0.2, 0.5);
        expect(isRefusal(r)).toBe(false);
        if (!isRefusal(r)) expect(tiers(r)).toEqual([1, 3]);
    });

    it('marks ALONE in open water are NOT a channel — they stay tier-3 (need charted/canal water too)', () => {
        const grid = makeGrid(); // no preferred, no injected — plain open water
        // a pair of lateral marks beside the SOUTH third of the line, but NO DRGARE/
        // FAIRWY and NO injected-canal fill there — just open bay near scattered buoys.
        const lon = MIN_LON + 1.5 * dLon;
        const marks: LateralMark[] = [];
        for (let y = 2; y <= 20; y += 4) {
            const lat = MIN_LAT + (y + 0.5) * dLat;
            marks.push({ lat, lon: lon - 0.0005, side: 'port', key: 'X', seq: y, name: `X${y}` });
            marks.push({ lat, lon: lon + 0.0005, side: 'stbd', key: 'X', seq: y, name: `X${y}` });
        }
        const r = segmentRoute(corridorLine(), grid, marks, 2.4, 0.2, 0.5);
        expect(isRefusal(r)).toBe(false);
        // A route merely passing within 300 m of buoys in open water is the open bay,
        // NOT the marked channel exiting a marina → stays tier-2 (the "yellow in the
        // open bay" fix). Tier-2 YELLOW requires marks AND charted/injected channel water.
        if (!isRefusal(r)) expect(tiers(r)).toEqual([3]);
    });

    it('marks + INJECTED canal water = the buoyed exit channel → tier-2 (the Newport case)', () => {
        // South third is injected-canal water (Mapbox-water fill from the marina) AND
        // buoyed — that is the channel exiting the marina → tier-2 YELLOW. North is open
        // deep water → tier-3. This locks the real Newport exit-channel classification.
        const grid = makeGrid({ injectedY: (y) => y <= 22 });
        const lon = MIN_LON + 1.5 * dLon;
        const marks: LateralMark[] = [];
        for (let y = 2; y <= 20; y += 4) {
            const lat = MIN_LAT + (y + 0.5) * dLat;
            marks.push({ lat, lon: lon - 0.0005, side: 'port', key: 'X', seq: y, name: `X${y}` });
            marks.push({ lat, lon: lon + 0.0005, side: 'stbd', key: 'X', seq: y, name: `X${y}` });
        }
        const r = segmentRoute(corridorLine(), grid, marks, 2.4, 0.2, 0.5);
        expect(isRefusal(r)).toBe(false);
        if (!isRefusal(r)) expect(tiers(r)).toEqual([2, 3]); // buoyed injected channel → tier-2, deep north → tier-3
    });

    it('a forced chart egress track stays tier-2 without regional midpoint marks', () => {
        // Offline Newport fallback: chart RECTRC can supply the canal lead-out even
        // when Supabase regional midpoint chains are absent. Once the engine picks
        // that track, segmentation must preserve it as tier-2 instead of treating it
        // as ordinary inshore bay water just because there are no parsed marks.
        const grid = makeGrid({ injectedY: (y) => y <= 7 });
        const line = corridorLine(1, 30);
        const forceTier2 = line.map((_, i) => i >= 7 && i <= 13);
        const r = segmentRoute(line, grid, [], 2.4, 0.2, 0.5, { refuseUnchartedRunM: null, forceTier2 });
        expect(isRefusal(r)).toBe(false);
        if (!isRefusal(r)) expect(tiers(r)).toEqual([1, 2, 3]);
    });

    it('a forced egress chain owns tier-2; the just-beyond-gate tail returns to tier-3', () => {
        const grid = makeGrid({ injectedY: () => true });
        const line = corridorLine(1, 20);
        const lon = MIN_LON + 1.5 * dLon;
        const marks: LateralMark[] = [];
        for (let y = 8; y <= 18; y += 2) {
            const lat = MIN_LAT + (y + 0.5) * dLat;
            marks.push({ lat, lon: lon - 0.0005, side: 'port', key: 'X', seq: y, name: `X${y}` });
            marks.push({ lat, lon: lon + 0.0005, side: 'stbd', key: 'X', seq: y, name: `X${y}` });
        }
        const forceTier2 = line.map((_, i) => i >= 7 && i <= 12);
        const r = segmentRoute(line, grid, marks, 2.4, 0.2, 0.5, { refuseUnchartedRunM: null, forceTier2 });
        expect(isRefusal(r)).toBe(false);
        if (!isRefusal(r)) expect(tiers(r)).toEqual([1, 2, 3]);
    });

    it('YELLOW ends AT the last gate even when channel-water bleeds far past it; a DISTANT channel keeps tier-2', () => {
        // Shane's Newport EXIT: canal (injected) → forced exit gates → a LONG dredged/
        // injected bleed past the last gate (>675 m, which USED to stay YELLOW into the
        // bay) → open bay → a DISTANT marked channel (the Brisbane River by the dest,
        // which MUST keep its tier-2). The bounded egress-open-tail suppression turns the
        // bleed TEAL up to the open bay, then stops — so the distant river stays YELLOW.
        const grid = makeGrid({
            injectedY: (y) => y <= 6, // canal + a couple cells
            // exit dredged bleed (~1100 m, used to stay yellow) + a DISTANT river channel
            // past the 2500 m egress-adjacent window (the real Brisbane River is ~15 km out).
            preferredY: (y) => (y >= 7 && y <= 28) || y >= 60,
        });
        const lon = MIN_LON + 1.5 * dLon;
        const line = corridorLine(1, 68);
        const marks: LateralMark[] = [];
        for (let y = 3; y <= 7; y += 2) {
            const lat = MIN_LAT + (y + 0.5) * dLat; // exit gates
            marks.push({ lat, lon: lon - 0.0005, side: 'port', key: 'G', seq: y, name: `G${y}` });
            marks.push({ lat, lon: lon + 0.0005, side: 'stbd', key: 'G', seq: y, name: `G${y}` });
        }
        const forceTier2 = line.map((_, i) => i >= 2 && i <= 6); // last forced vertex = i=6 (y=7)
        const r = segmentRoute(line, grid, marks, 2.4, 0.2, 0.5, { refuseUnchartedRunM: null, forceTier2 });
        expect(isRefusal(r)).toBe(false);
        if (isRefusal(r)) return;
        expect(tiers(r)).toEqual([1, 2, 3, 2]); // canal, gates, bleed+bay TEAL, distant river YELLOW
        expect(r[1].toIdx).toBe(6); // YELLOW ends exactly at the last gate, not in the bleed
        expect(r[3].tier).toBe(2); // distant marked channel preserved
    });

    it('CHANNEL FILL: patchy preferred between gates coalesces to ONE tier-2 span (the Newport stepping)', () => {
        // Gates (marks + preferred) at y=2,6,10,14,18 — 200 m apart — with the preferred
        // flag present ONLY at the gate rows (a real channel's charted/injected flag is
        // patchy BETWEEN buoys). The 450 m nearMark reach bridges the gaps, but step-1
        // alone flickers t4 (gate) / t2 (between) — the stepped RED/YELLOW. The channel-fill
        // pass promotes the whole nearMark run to ONE tier-2 channel.
        const gates = [2, 6, 10, 14, 18];
        const grid = makeGrid({ preferredY: (y) => gates.includes(y) });
        const lon = MIN_LON + 1.5 * dLon;
        const marks: LateralMark[] = [];
        for (const y of gates) {
            const lat = MIN_LAT + (y + 0.5) * dLat;
            marks.push({ lat, lon: lon - 0.0005, side: 'port', key: 'X', seq: y, name: `X${y}` });
            marks.push({ lat, lon: lon + 0.0005, side: 'stbd', key: 'X', seq: y, name: `X${y}` });
        }
        const r = segmentRoute(corridorLine(), grid, marks, 2.4, 0.2, 0.5);
        expect(isRefusal(r)).toBe(false);
        if (!isRefusal(r)) expect(tiers(r)).toEqual([2, 3]); // ONE contiguous tier-2 channel, deep north
    });

    it('marks inside a dredged corridor are STILL tier-2 (lateral marks win over dredged)', () => {
        // The SAME south marks, but the south is ALSO a preferred (DRGARE/FAIRWY)
        // corridor. A buoyed channel is steered by its gates → tier-2 YELLOW even
        // where it's dredged; the dredging is just context. So south → tier-2.
        const grid = makeGrid({ preferredY: (y) => y <= 25 });
        const lon = MIN_LON + 1.5 * dLon;
        const marks: LateralMark[] = [];
        for (let y = 2; y <= 20; y += 4) {
            const lat = MIN_LAT + (y + 0.5) * dLat;
            marks.push({ lat, lon: lon - 0.0005, side: 'port', key: 'X', seq: y, name: `X${y}` });
            marks.push({ lat, lon: lon + 0.0005, side: 'stbd', key: 'X', seq: y, name: `X${y}` });
        }
        const r = segmentRoute(corridorLine(), grid, marks, 2.4, 0.2, 0.5);
        expect(isRefusal(r)).toBe(false);
        if (!isRefusal(r)) expect(tiers(r)).toEqual([2, 3]); // buoyed (even dredged) → tier-2, north deep → tier-3
    });

    it('a short tier flap is absorbed (hysteresis): 1 deep cell amid a channel stays [3]', () => {
        // channel everywhere except ONE cell (y=35) that reads non-preferred deep
        const grid = makeGrid({ preferredY: (y) => y !== 35 });
        const r = segmentRoute(corridorLine(), grid, [], 2.4, 0.2, 0.5);
        expect(isRefusal(r)).toBe(false);
        if (!isRefusal(r)) expect(tiers(r)).toEqual([2]); // the single deep cell absorbed
    });

    it('a long uncharted (no-evidence) run refuses before any router runs', () => {
        // middle third unvouched (UNKNOWN_OPEN) over > UNCHARTED_MAX_RUN_M (1852 m)
        const grid = makeGrid({ unvouchedY: (y) => y >= 20 && y <= 60 }); // ~40 cells ≈ 2 km
        const r = segmentRoute(corridorLine(), grid, [], 2.4, 0.2, 0.5);
        expect(isRefusal(r)).toBe(true);
        if (isRefusal(r)) expect(r.reason).toBe('uncharted-run');
    });
});
