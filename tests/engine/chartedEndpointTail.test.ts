/**
 * Owner decision 7 (Shane, 2026-09-30): "Carry on, amber".
 *
 * When a pin sits in CHARTED shallow water — a never-drying S-57 band
 * shallower than draft + UKC, or decision-1 water (a finer never-drying band
 * under a coarser chart's land paint) — the route runs ALL the way to the pin.
 * The stretch past the last water deep enough for the keel is marked 'needs
 * tide' with its charted depth (red caution in cautionMask, an amber tide chip
 * from shallowRuns), and the route stays a route (saveable). It used to stop
 * at the nearest deep-enough water: 429 m short of the Tangalooma pin.
 *
 * Hard limits: never land, never a drying band, never a hazard buffer, never
 * uncharted water, never a structure bar — and the tail is only the stretch
 * between the last deep water and the pin. A pin on land or on a drying bank
 * gets a route that stops at the edge of the water the chart does not paint
 * drying or land (round 3, 2026-09-30), and the result says so.
 */
import type { Feature, FeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteRequest, type RouteResult } from '../../services/inshoreRouterEngine';
import type { InshoreLayers } from '../../services/engine/types';
import { chartClearanceBars, polylineCrossesClearanceBar } from '../../services/routing/overheadClearance';
import { hardLandAtPoint } from '../../services/engine/safetyAudit';
import { buildChartAreaIndex, chartedDepthAt } from '../../services/routing/leadLandClip';

const rect = (x0: number, y0: number, x1: number, y1: number, props: Record<string, unknown>): Feature => ({
    type: 'Feature',
    properties: props,
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [x0, y0],
                [x1, y0],
                [x1, y1],
                [x0, y1],
                [x0, y0],
            ],
        ],
    },
});
const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const band = (x0: number, x1: number, DRVAL1: number, extra: Record<string, unknown> = {}) =>
    rect(x0, -27.52, x1, -27.48, { acronym: 'DEPARE', DRVAL1, DRVAL2: DRVAL1 + 2, ...extra });

// West to east: deep water, a charted 1 m band, a drying bank, the shore.
const DEEP_E = 153.46;
const SHALLOW_E = 153.48;
const DRYING_E = 153.49;
const bay = (): InshoreLayers => ({
    DEPARE: fc(band(153.38, DEEP_E, 10), band(DEEP_E, SHALLOW_E, 1), band(SHALLOW_E, DRYING_E, -1)),
    LNDARE: fc(rect(DRYING_E, -27.53, 153.52, -27.47, { acronym: 'LNDARE' })),
});
const req = (fromLon: number, toLon: number, extra: Partial<RouteRequest> = {}): RouteRequest => ({
    fromLat: -27.5,
    fromLon,
    toLat: -27.5,
    toLon,
    draftM: 2.4,
    safetyM: 0.2,
    resolutionM: 50,
    ...extra,
});
const isResult = (r: ReturnType<typeof routeInshore>): r is RouteResult => 'polyline' in r;
const hav = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 6371000;
    const r = Math.PI / 180;
    const a =
        Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
        Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
};
const endGap = (r: RouteResult, q: RouteRequest): number => {
    const [lon, lat] = r.polyline[r.polyline.length - 1];
    return hav(q.toLat, q.toLon, lat, lon);
};
/** Metres from the charted band's deep edge to the pin (the tail's length). */
const tailM = (pinLon: number) => hav(-27.5, DEEP_E, -27.5, pinLon);

describe('decision 7 — a pin in charted-shallow water gets the route all the way to it', () => {
    it('runs to the pin; the stretch past the deep water is caution with its charted depth, a destination tail', () => {
        const q = req(153.41, 153.475);
        const r = routeInshore(bay(), q);
        expect(isResult(r), 'error' in r ? r.error : '').toBe(true);
        if (!isResult(r)) return;
        // Was: the route stopped at the nearest deep-enough water ~1.5 km short.
        expect(endGap(r, q)).toBeLessThan(1);
        expect(r.cautionMask?.[r.cautionMask.length - 1]).toBe(true);
        const tail = r.shallowRuns?.find((s) => s.endpointTail === 'destination');
        expect(tail, JSON.stringify(r.shallowRuns)).toBeDefined();
        expect(tail!.minDepthM).toBe(1);
        expect(tail!.endSeg).toBe(r.polyline.length - 2);
        // Only the stretch between the last deep water and the pin.
        expect(tail!.lengthM).toBeGreaterThan(tailM(153.475) - 120);
        expect(tail!.lengthM).toBeLessThan(tailM(153.475) + 120);
        // The rest of the route is clean deep water.
        expect(r.cautionMask!.slice(0, tail!.startSeg).some(Boolean)).toBe(false);
        expect(r.pinOffWater).toBeUndefined();
        expect(r.debug?.destinationChartedPin).toBe(true);
    });

    it('a short tail is marked too (other caution runs need 200 m)', () => {
        const q = req(153.41, DEEP_E + 0.0012);
        const r = routeInshore(bay(), q);
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(endGap(r, q)).toBeLessThan(1);
        const tail = r.shallowRuns?.find((s) => s.endpointTail === 'destination');
        expect(tail).toBeDefined();
        expect(tail!.lengthM).toBeLessThan(200);
        expect(tail!.minDepthM).toBe(1);
    });

    it('symmetrically, a departure from charted-shallow water starts at the pin, its head a needs-tide tail', () => {
        const q = req(153.475, 153.41);
        const r = routeInshore(bay(), q);
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(r.polyline[0]).toEqual([q.fromLon, q.fromLat]);
        expect(r.cautionMask?.[0]).toBe(true);
        const head = r.shallowRuns?.find((s) => s.endpointTail === 'origin');
        expect(head, JSON.stringify(r.shallowRuns)).toBeDefined();
        expect(head!.startSeg).toBe(0);
        expect(head!.minDepthM).toBe(1);
        // No fabricated 5 m departure bubble over the chart's own 1 m band.
        expect(head!.lengthM).toBeGreaterThan(tailM(153.475) - 120);
        expect(r.debug?.originChartedPin).toBe(true);
    });

    it('decision-1 water: a finer never-drying band under coarser land paint is a charted pin too', () => {
        const layers: InshoreLayers = {
            DEPARE: fc(
                band(153.38, DEEP_E, 10, { _scaleRank: 3000 }),
                band(DEEP_E, SHALLOW_E, 8, { _scaleRank: 5000 }),
            ),
            // Overview land paint bulging over the finer cell's 8 m band.
            LNDARE: fc(rect(153.47, -27.53, 153.52, -27.47, { acronym: 'LNDARE', _scaleRank: 1000 })),
        };
        const q = req(153.41, 153.475);
        const r = routeInshore(layers, q);
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(endGap(r, q)).toBeLessThan(1);
        expect(r.cautionMask?.[r.cautionMask.length - 1]).toBe(true);
        expect(r.shallowRuns?.some((s) => s.endpointTail === 'destination')).toBe(true);
    });
});

/** Metres of the route over charted drying ground or hard land (every ~2 m). */
const offWaterM = (layers: InshoreLayers, poly: readonly [number, number][]): number => {
    const land = hardLandAtPoint(layers);
    const bands = buildChartAreaIndex(layers).depth;
    let m = 0;
    for (let i = 0; i + 1 < poly.length; i++) {
        const segM = hav(poly[i][1], poly[i][0], poly[i + 1][1], poly[i + 1][0]);
        const n = Math.max(1, Math.ceil(segM / 2));
        for (let k = 0; k < n; k++) {
            const t = (k + 0.5) / n;
            const lon = poly[i][0] + (poly[i + 1][0] - poly[i][0]) * t;
            const lat = poly[i][1] + (poly[i + 1][1] - poly[i][1]) * t;
            const d = chartedDepthAt(bands, lon, lat);
            if (land(lon, lat) || (d !== null && d < 0)) m += segM / n;
        }
    }
    return m;
};

describe('decision 7 — the hard limits', () => {
    // Round 3 (2026-09-30): decision 7's limit is never drying. A pin on a
    // drying bank used to keep "today's ending" — the nearest cell it snapped
    // to, ON the bank: the route crossed charted drying ground to end metres
    // from the pin. It now stops at the bank's edge (the last water the chart
    // does not paint drying or land, nearest the pin), and says so.
    it('a pin on a drying bank: the route stops at the edge of the bank, and the result says it dries', () => {
        const q = req(153.41, 153.485);
        const layers = bay();
        const r = routeInshore(layers, q);
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(r.pinOffWater).toEqual({ destination: 'drying' });
        expect(r.shallowRuns?.some((s) => s.endpointTail)).toBe(false);
        expect(r.debug?.destinationChartedPin).toBeUndefined();
        // Was: ~490 m of the bank crossed, ending ~30 m from the pin.
        expect(offWaterM(layers, r.polyline)).toBeLessThan(1);
        const [endLon] = r.polyline[r.polyline.length - 1];
        expect(Math.abs(hav(-27.5, endLon, -27.5, SHALLOW_E))).toBeLessThan(5);
        expect(r.debug?.pinEdgeTrimM?.destination).toBeGreaterThan(400);
    });

    // Round-3 review (2026-09-30): the pin was classed by its 50 m CELL. A
    // pin 3–22 m inside the 1 m band, whose cell centre fell in the drying
    // band beside it, read 'drying' — the route was cut a few metres short,
    // the notice said the pin dries, and it got no decision-7 tail, though
    // the chart at the pin says 1 m. The pin itself is read now, exactly.
    it('a pin just inside a never-drying band beside a drying one is a charted pin, never "on a drying bank"', () => {
        const layers = bay();
        const mPerLon = 111_320 * Math.cos((27.5 * Math.PI) / 180);
        for (const inM of [3, 8, 13, 18, 22]) {
            const q = req(153.41, SHALLOW_E - inM / mPerLon);
            expect(chartedDepthAt(buildChartAreaIndex(layers).depth, q.toLon, q.toLat)).toBe(1);
            const r = routeInshore(layers, q);
            expect(isResult(r), `${inM} m`).toBe(true);
            if (!isResult(r)) continue;
            expect(r.pinOffWater, `${inM} m`).toBeUndefined();
            expect(endGap(r, q), `${inM} m`).toBeLessThan(1);
            const tail = r.shallowRuns?.find((s) => s.endpointTail === 'destination');
            expect(tail?.minDepthM, `${inM} m`).toBe(1);
            expect(offWaterM(layers, r.polyline), `${inM} m`).toBeLessThan(1);
        }
    });

    it('a pin on land: the route stops at the water’s edge, never on the drying foreshore in front of it', () => {
        const q = req(153.41, 153.5);
        const layers = bay();
        const r = routeInshore(layers, q);
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(r.pinOffWater).toEqual({ destination: 'land' });
        expect(r.shallowRuns?.some((s) => s.endpointTail)).toBe(false);
        expect(offWaterM(layers, r.polyline)).toBeLessThan(1);
    });

    it('a departure from charted land behind a drying foreshore starts at the water’s edge', () => {
        const lat = -26.55;
        const layers: InshoreLayers = {
            DEPARE: fc(
                rect(153.38, lat - 0.02, DEEP_E, lat + 0.02, { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 12 }),
                rect(DEEP_E, lat - 0.02, SHALLOW_E, lat + 0.02, { acronym: 'DEPARE', DRVAL1: 1, DRVAL2: 3 }),
                rect(SHALLOW_E, lat - 0.02, DRYING_E, lat + 0.02, { acronym: 'DEPARE', DRVAL1: -1, DRVAL2: 1 }),
            ),
            LNDARE: fc(rect(DRYING_E, lat - 0.03, 153.52, lat + 0.03, { acronym: 'LNDARE' })),
        };
        const r = routeInshore(layers, { ...req(153.5, 153.41), fromLat: lat, toLat: lat });
        expect(isResult(r), 'error' in r ? r.error : '').toBe(true);
        if (!isResult(r)) return;
        expect(r.pinOffWater).toEqual({ origin: 'land' });
        // Was: the route started AT the pin, through its 60 m carve bubble
        // over land and on across the drying foreshore.
        expect(offWaterM(layers, r.polyline)).toBeLessThan(1);
        expect(Math.abs(hav(lat, r.polyline[0][0], lat, SHALLOW_E))).toBeLessThan(5);
    });

    it('symmetrically, a departure from a drying bank starts at its edge', () => {
        const lat = -26.6;
        const layers: InshoreLayers = {
            DEPARE: fc(
                rect(153.38, lat - 0.02, DEEP_E, lat + 0.02, { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 12 }),
                rect(DEEP_E, lat - 0.02, SHALLOW_E, lat + 0.02, { acronym: 'DEPARE', DRVAL1: 1, DRVAL2: 3 }),
                rect(SHALLOW_E, lat - 0.02, DRYING_E, lat + 0.02, { acronym: 'DEPARE', DRVAL1: -1, DRVAL2: 1 }),
            ),
            LNDARE: fc(rect(DRYING_E, lat - 0.03, 153.52, lat + 0.03, { acronym: 'LNDARE' })),
        };
        const r = routeInshore(layers, { ...req(153.485, 153.41), fromLat: lat, toLat: lat });
        expect(isResult(r), 'error' in r ? r.error : '').toBe(true);
        if (!isResult(r)) return;
        expect(r.pinOffWater).toEqual({ origin: 'drying' });
        expect(offWaterM(layers, r.polyline)).toBeLessThan(1);
        expect(Math.abs(hav(lat, r.polyline[0][0], lat, SHALLOW_E))).toBeLessThan(5);
        // Every per-segment mask still fits the trimmed line.
        expect(r.cautionMask).toHaveLength(r.polyline.length - 1);
        expect(r.canalMask).toHaveLength(r.polyline.length - 1);
    });

    it('charted-shallow water walled off from deep water by a drying bank is no tail: never through the drying', () => {
        // The 1 m pocket lies beyond the drying bank.
        const layers: InshoreLayers = {
            DEPARE: fc(band(153.38, DEEP_E, 10), band(DEEP_E, 153.47, -1), band(153.47, SHALLOW_E, 1)),
            LNDARE: fc(rect(SHALLOW_E, -27.53, 153.52, -27.47, { acronym: 'LNDARE' })),
        };
        // A different departure: the grid cache keys on feature COUNTS, and
        // this layer set counts the same as bay().
        const r = routeInshore(layers, req(153.412, 153.475));
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(r.debug?.destinationChartedPin).toBeUndefined();
        expect(r.shallowRuns?.some((s) => s.endpointTail)).toBe(false);
    });

    it('uncharted water is never a charted pin (Phase 2b’s local connector)', () => {
        const layers: InshoreLayers = { DEPARE: fc(band(153.38, DEEP_E, 10)) };
        const r = routeInshore(layers, req(153.41, 153.475));
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(r.debug?.destinationChartedPin).toBeUndefined();
        expect(r.shallowRuns?.some((s) => s.endpointTail)).toBe(false);
    });

    it('a charted wreck at the pin: its buffer is never a charted pin', () => {
        const layers: InshoreLayers = {
            ...bay(),
            WRECKS: fc({
                type: 'Feature',
                properties: { acronym: 'WRECKS' },
                geometry: { type: 'Point', coordinates: [153.475, -27.5] },
            }),
        };
        const r = routeInshore(layers, req(153.41, 153.475));
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(r.debug?.destinationChartedPin).toBeUndefined();
    });
});

// ── Fix-up for Phase 2a round 2 (2026-09-30) ─────────────────────────────
// Each layer set below sits on its own latitude band (and so its own grid
// bbox), so no two tests share a cached grid.
const bandAt = (lat: number, x0: number, x1: number, DRVAL1: number, extra: Record<string, unknown> = {}) =>
    rect(x0, lat - 0.02, x1, lat + 0.02, { acronym: 'DEPARE', DRVAL1, DRVAL2: DRVAL1 + 2, ...extra });
const reqAt = (lat: number, fromLon: number, toLon: number): RouteRequest => ({
    ...req(fromLon, toLon),
    fromLat: lat,
    toLat: lat,
});

describe('decision 2 binds decision-1 water: only a DEEP finest band under land paint is a charted pin', () => {
    it('a 0–2 m finer band under coarser land paint (the offline Newport canal) is no charted pin', () => {
        const lat = -27.3;
        const layers: InshoreLayers = {
            DEPARE: fc(
                bandAt(lat, 153.38, DEEP_E, 10, { _scaleRank: 3000 }),
                bandAt(lat, DEEP_E, SHALLOW_E, 0, { _scaleRank: 5000 }),
            ),
            LNDARE: fc(rect(153.47, lat - 0.03, 153.52, lat + 0.03, { acronym: 'LNDARE', _scaleRank: 1000 })),
        };
        const r = routeInshore(layers, reqAt(lat, 153.41, 153.475));
        expect(isResult(r), 'error' in r ? r.error : '').toBe(true);
        if (!isResult(r)) return;
        expect(r.debug?.destinationChartedPin).toBeUndefined();
        expect(r.shallowRuns?.some((s) => s.endpointTail)).toBe(false);
    });

    it('the same shallow band with NO land paint over it is still a charted pin', () => {
        const lat = -27.2;
        const layers: InshoreLayers = {
            DEPARE: fc(
                bandAt(lat, 153.38, DEEP_E, 10, { _scaleRank: 3000 }),
                bandAt(lat, DEEP_E, SHALLOW_E, 0, { _scaleRank: 5000 }),
            ),
        };
        const r = routeInshore(layers, reqAt(lat, 153.41, 153.475));
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(r.debug?.destinationChartedPin).toBe(true);
        expect(r.shallowRuns?.find((s) => s.endpointTail === 'destination')?.minDepthM).toBe(0);
    });
});

describe('the tail’s charted depth is the FINEST survey’s', () => {
    it('a decision-1 tail over a finer 8 m band reads no tide window, and names the coarser land paint', () => {
        const lat = -27.1;
        const layers: InshoreLayers = {
            DEPARE: fc(
                bandAt(lat, 153.38, DEEP_E, 10, { _scaleRank: 3000 }),
                bandAt(lat, DEEP_E, SHALLOW_E, 8, { _scaleRank: 5000 }),
                // A general cell's generalised 0 m band under both (Tangalooma's
                // band-2 rcid 1476 class): coarser, so it charts nothing here.
                bandAt(lat, 153.38, 153.52, 0, { _scaleRank: 2000 }),
            ),
            LNDARE: fc(rect(153.47, lat - 0.03, 153.52, lat + 0.03, { acronym: 'LNDARE', _scaleRank: 1000 })),
        };
        const r = routeInshore(layers, reqAt(lat, 153.41, 153.475));
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        const tail = r.shallowRuns?.find((s) => s.endpointTail === 'destination');
        expect(tail, JSON.stringify(r.shallowRuns)).toBeDefined();
        // Was 0 (the coarser band): "+2.9 m — no window in 24 h" on 8 m water.
        expect(tail!.minDepthM).toBeNull();
        expect(tail!.coarserLandPaint).toBe(true);
        expect(tail!.finestDepthM).toBe(8);
    });

    it('a charted-shallow tail reads its finest band, not a coarser drying band under it', () => {
        const lat = -27.0;
        const layers: InshoreLayers = {
            DEPARE: fc(
                bandAt(lat, 153.38, DEEP_E, 10, { _scaleRank: 5000 }),
                bandAt(lat, DEEP_E, SHALLOW_E, 1, { _scaleRank: 5000 }),
                bandAt(lat, DEEP_E, SHALLOW_E, -1, { _scaleRank: 2000 }),
            ),
        };
        const r = routeInshore(layers, reqAt(lat, 153.41, 153.475));
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(r.shallowRuns?.find((s) => s.endpointTail === 'destination')?.minDepthM).toBe(1);
    });
});

describe('the tail is checked against the chart itself, not the 50 m cells', () => {
    it('a 40 m drying strip between cell centres walling the pin off: no tail, today’s ending, and why', () => {
        const lat = -26.9;
        // The strip sits on a cell EDGE of the route's grid (the engine's own
        // bbox padding and cell width), so the cell centres either side of it
        // are 25 m away and neither cell reads drying.
        const q = reqAt(lat, 153.41, 153.475);
        const pad = Math.max((q.toLon - q.fromLon) * 0.5, 0.08);
        const gridMinLon = q.fromLon - pad;
        const gridMinLat = lat - pad;
        const gridMaxLat = lat + pad;
        const dLon = 50 / (111_320 * Math.cos((((gridMinLat + gridMaxLat) / 2) * Math.PI) / 180));
        const edge = gridMinLon + Math.ceil((153.47 - gridMinLon) / dLon) * dLon;
        const strip = rect(edge - 0.0002, lat - 0.02, edge + 0.0002, lat + 0.02, {
            acronym: 'DEPARE',
            DRVAL1: -1,
            DRVAL2: 0,
        });
        const layers: InshoreLayers = {
            DEPARE: fc(bandAt(lat, 153.38, DEEP_E, 10), bandAt(lat, DEEP_E, SHALLOW_E, 1), strip),
        };
        const r = routeInshore(layers, q);
        expect(isResult(r), 'error' in r ? r.error : '').toBe(true);
        if (!isResult(r)) return;
        expect(r.shallowRuns?.some((s) => s.endpointTail)).toBe(false);
        expect(r.debug?.chartedEndRejected).toMatch(/drying/);
    });

    // Round-4 review (2026-09-30): the exact tail check refused charted land,
    // drying bands and low structures, but passed a spot no band covers — a
    // gap between two charted-caution cells. Decision 7: never uncharted.
    it('a 40 m strip no chart covers between cell centres walling the pin off: no tail, today’s ending, and why', () => {
        const lat = -26.85;
        const q = reqAt(lat, 153.41, 153.475);
        const pad = Math.max((q.toLon - q.fromLon) * 0.5, 0.08);
        const gridMinLon = q.fromLon - pad;
        const gridMinLat = lat - pad;
        const gridMaxLat = lat + pad;
        const dLon = 50 / (111_320 * Math.cos((((gridMinLat + gridMaxLat) / 2) * Math.PI) / 180));
        const edge = gridMinLon + Math.ceil((153.47 - gridMinLon) / dLon) * dLon;
        const layers: InshoreLayers = {
            DEPARE: fc(
                bandAt(lat, 153.38, DEEP_E, 10),
                bandAt(lat, DEEP_E, edge - 0.0002, 1),
                bandAt(lat, edge + 0.0002, SHALLOW_E, 1),
            ),
        };
        const r = routeInshore(layers, q);
        expect(isResult(r), 'error' in r ? r.error : '').toBe(true);
        if (!isResult(r)) return;
        expect(r.shallowRuns?.some((s) => s.endpointTail)).toBe(false);
        expect(r.debug?.chartedEndRejected).toMatch(/no chart covers/);
    });

    it('a fixed bridge across the shallow band: never a tail squeezed diagonally under it, never a refusal', () => {
        const lat = -26.8;
        // A ~45° bridge right across a narrow 1 m band between the deep water
        // and the pin. Its bar rasterises as a one-cell diagonal staircase: a
        // diagonal step between two barred cells crossed it, and the exact
        // mast gate then refused the WHOLE route (a false refusal).
        const bridge: Feature = {
            type: 'Feature',
            properties: { acronym: 'BRIDGE', VERCLR: 10, rcid: 7 },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [153.465, lat - 0.0045],
                    [153.474, lat + 0.0045],
                ],
            },
        };
        const bars = chartClearanceBars({ BRIDGE: [bridge] }, 18);
        const layers: InshoreLayers = {
            DEPARE: fc(
                bandAt(lat, 153.38, DEEP_E, 10),
                rect(DEEP_E, lat - 0.004, SHALLOW_E, lat + 0.004, { acronym: 'DEPARE', DRVAL1: 1, DRVAL2: 3 }),
            ),
            OBSTRN: fc(...bars),
        };
        const q = reqAt(lat, 153.41, 153.477);
        const r = routeInshore(layers, q);
        expect(isResult(r), 'error' in r ? r.error : '').toBe(true);
        if (!isResult(r)) return;
        expect(polylineCrossesClearanceBar(r.polyline, bars)).toBeNull();
        expect(r.shallowRuns?.some((s) => s.endpointTail)).toBe(false);
    });
});

describe('a pin whose charted water reaches deep water the route does not use', () => {
    it('re-runs with today’s endpoints, and says why', () => {
        const lat = -26.7;
        // The pin's 1 m band holds a finer survey's 10 m pocket (its nearest
        // deep water); land walls the band off from the open water 8 km west,
        // so the route cannot use the pocket's water at all — it would have
        // started AT the pin with no charted head and no carve bubble.
        const wall = (x0: number, y0: number, x1: number, y1: number) => rect(x0, y0, x1, y1, { acronym: 'LNDARE' });
        const layers: InshoreLayers = {
            DEPARE: fc(
                rect(153.28, lat - 0.02, 153.4, lat + 0.02, { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 12 }),
                rect(153.47, lat - 0.004, 153.49, lat + 0.004, {
                    acronym: 'DEPARE',
                    DRVAL1: 1,
                    DRVAL2: 2,
                    _scaleRank: 4000,
                }),
                // A finer survey's pocket inside the band (at one rank, the
                // shallower band would win the pocket too).
                rect(153.4795, lat - 0.0008, 153.4805, lat + 0.0002, {
                    acronym: 'DEPARE',
                    DRVAL1: 10,
                    DRVAL2: 12,
                    _scaleRank: 5000,
                }),
            ),
            LNDARE: fc(
                wall(153.4, lat - 0.2, 153.47, lat + 0.2),
                wall(153.47, lat + 0.004, 153.49, lat + 0.2),
                wall(153.47, lat - 0.2, 153.49, lat - 0.004),
                wall(153.49, lat - 0.2, 153.6, lat + 0.2),
            ),
        };
        const r = routeInshore(layers, reqAt(lat, 153.482, 153.35));
        expect(isResult(r), 'error' in r ? r.error : '').toBe(true);
        if (!isResult(r)) return;
        expect(r.debug?.originChartedPin).toBeUndefined();
        expect(r.debug?.chartedEndRejected).toMatch(/does not use/);
    });
});
