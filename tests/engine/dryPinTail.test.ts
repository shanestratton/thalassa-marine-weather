/**
 * Route to the pin even when the pin is on drying ground (package 125-05b).
 *
 * Shane, 2026-10-08: "tried to do a route from the newport canals to
 * tangalooma, i got some message about it being dry at both ends???? again,
 * no one is going to use it, if it is too tight. better we just have red at
 * the "dry" zones, rather than just shit caning the whole route".
 *
 * A pin on charted drying ground (or in water no tide clears) used to get a
 * route that stopped at the edge of the water — 153–220 m short of the
 * Tangalooma beach pins on the real cells — and "Your destination pin is on a
 * drying bank — the route stops at its edge". Now the route runs on across
 * the drying ground to the pin: a dry tail drawn RED whatever the tide, and
 * named like 125-05's dry stretches (RouteResult.dryRuns, with `pin`). A pin
 * in water beyond a drying band that the route stopped more than 500 m short
 * of is reached the same way. Never across charted land: a pin on land keeps
 * the honest stop at the water's edge, and a gap across land is no tail.
 *
 * A global app: a fictional island at 27° S, 40° W (the South Atlantic, west
 * longitudes) and a fictional Wadden harbour at 53.4° N, 5.3° E. Synthetic
 * charts only. Serene Summer: 2.4 m draft, 0.5 m under the keel — 2.9 m.
 */
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
    fineRefinementIsBetter,
    relaxedRescueFault,
    routeInshore,
    type RouteRequest,
    type RouteResult,
} from '../../services/inshoreRouterEngine';
import type { DryRun, InshoreLayers, TideCeiling } from '../../services/engine/types';
import { auditUnvouchedHardLand } from '../../services/engine/safetyAudit';
import { buildChartAreaIndex, chartedDepthAt } from '../../services/routing/leadLandClip';
import { pointInGeometry } from '../../services/engine/geometry';
import {
    inshoreRoutePieces,
    inshoreSegmentStates,
    routeTideDepths,
    type InshoreRoutePiece,
} from '../../components/map/inshoreRouteState';

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
const depare = (x0: number, y0: number, x1: number, y1: number, DRVAL1: number, DRVAL2: number): Feature =>
    rect(x0, y0, x1, y1, { acronym: 'DEPARE', DRVAL1, DRVAL2 });
const land = (x0: number, y0: number, x1: number, y1: number): Feature => rect(x0, y0, x1, y1, { acronym: 'LNDARE' });
/** Specks of land far off the route: each test keys its own grid (the grid
 *  cache keys on feature counts). */
const specks = (n: number, x: number, y: number): Feature[] =>
    Array.from({ length: n }, (_, i) => land(x + i * 0.002, y, x + i * 0.002 + 0.0005, y + 0.0005));

const hav = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 6371000;
    const r = Math.PI / 180;
    const a =
        Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
        Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
};
const isResult = (r: ReturnType<typeof routeInshore>): r is RouteResult => 'polyline' in r;
const endGap = (r: RouteResult, q: RouteRequest): number => {
    const [lon, lat] = r.polyline[r.polyline.length - 1];
    return hav(q.toLat, q.toLon, lat, lon);
};
const startGap = (r: RouteResult, q: RouteRequest): number =>
    hav(q.fromLat, q.fromLon, r.polyline[0][1], r.polyline[0][0]);
const pinRun = (r: RouteResult, end: 'origin' | 'destination'): DryRun | undefined =>
    r.dryRuns?.find((d) => d.pin?.end === end);

/** One ceiling per 0.25° bucket round a spot, all `highestM`, 14 days. */
const ceilings = (lat0: number, lon0: number, highestM: number): TideCeiling[] => {
    const out: TideCeiling[] = [];
    for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
            out.push({
                lat: Math.round(lat0 * 4) / 4 + dy / 4,
                lon: Math.round(lon0 * 4) / 4 + dx / 4,
                highestM,
                days: 14,
            });
    return out;
};

/** The drawn pieces as the planner draws them, the tide top `highestM`. */
function pieces(r: RouteResult, highestM: number | null): InshoreRoutePiece[] {
    const states = inshoreSegmentStates(r);
    expect(states, 'the safety masks arrive intact').not.toBeNull();
    return inshoreRoutePieces(r.polyline, states!, r.surveyRuns ?? [], r.chartedShallowSpans ?? [], {
        depthM: routeTideDepths(r),
        needM: 2.9,
        highestM,
    });
}

/** The drawn state of every 5 m sample whose spot `inside` accepts. */
function statesWhere(ps: readonly InshoreRoutePiece[], inside: (lon: number, lat: number) => boolean): Set<string> {
    const out = new Set<string>();
    for (const p of ps) {
        for (let i = 0; i + 1 < p.coordinates.length; i++) {
            const [ax, ay] = p.coordinates[i];
            const [bx, by] = p.coordinates[i + 1];
            const n = Math.max(1, Math.ceil(hav(ay, ax, by, bx) / 5));
            for (let k = 0; k <= n; k++) {
                const x = ax + ((bx - ax) * k) / n;
                const y = ay + ((by - ay) * k) / n;
                if (inside(x, y)) out.add(p.state);
            }
        }
    }
    return out;
}

/** Metres of a route over charted drying ground (every ~2 m). */
function dryingM(layers: InshoreLayers, poly: readonly [number, number][]): number {
    const bands = buildChartAreaIndex(layers).depth;
    let m = 0;
    for (let i = 0; i + 1 < poly.length; i++) {
        const segM = hav(poly[i][1], poly[i][0], poly[i + 1][1], poly[i + 1][0]);
        const n = Math.max(1, Math.ceil(segM / 2));
        for (let k = 0; k < n; k++) {
            const t = (k + 0.5) / n;
            const d = chartedDepthAt(
                bands,
                poly[i][0] + (poly[i + 1][0] - poly[i][0]) * t,
                poly[i][1] + (poly[i + 1][1] - poly[i][1]) * t,
            );
            if (d !== null && d < 0) m += segM / n;
        }
    }
    return m;
}

// ── A fictional island at 27° S, 40° W, a drying beach on its west face ──
// West to east: 10–20 m water, 500 m of sand charted to dry 0.4 m (−0.4..0,
// "Kestrel Sands"), the island. The deep water reaches the sand's edge, so
// the router's deep-water snap used to end the route there, ~180–330 m short
// of a pin on the sand (the Tangalooma beach pins on the real cells).
const ISL_LAT = -27.0;
const SAND_W = -40.005;
const SAND_E = -40.0;
const M_LON_S = 111_320 * Math.cos((27 * Math.PI) / 180);
const PIN_SAND = SAND_W + 180 / M_LON_S;
const LAGOON: [number, number, number, number] = [-39.97, -27.005, -39.96, -26.995];
function island(variant: number): InshoreLayers {
    return {
        DEPARE: fc(
            depare(-40.2, -27.1, SAND_W, -26.9, 10, 20),
            depare(SAND_W, -27.1, -39.9, -27.05, 10, 20),
            depare(SAND_W, -26.95, -39.9, -26.9, 10, 20),
            depare(SAND_W, -27.05, SAND_E, -26.95, -0.4, 0),
            // A drying lagoon inside the island, ringed by its land.
            depare(...LAGOON, -0.4, 0),
        ),
        LNDARE: fc(
            land(SAND_E, -27.05, LAGOON[0], -26.95),
            land(LAGOON[2], -27.05, -39.9, -26.95),
            land(LAGOON[0], -27.05, LAGOON[2], LAGOON[1]),
            land(LAGOON[0], LAGOON[3], LAGOON[2], -26.95),
            ...specks(variant, -40.15, -27.09),
        ),
        SEAARE: fc(rect(SAND_W, -27.05, SAND_E, -26.95, { OBJNAM: 'Kestrel Sands' })),
    };
}
const onSand = (lon: number, lat: number): boolean =>
    lon > SAND_W + 15 / M_LON_S && lon < SAND_E && lat > -27.05 && lat < -26.95;
const islandReq = (extra: Partial<RouteRequest>): RouteRequest => ({
    fromLat: ISL_LAT,
    fromLon: -40.08,
    toLat: ISL_LAT,
    toLon: PIN_SAND,
    draftM: 2.4,
    safetyM: 0.5,
    resolutionM: 50,
    ...extra,
});

// ── A fictional Wadden harbour at 53.4° N, 5.3° E ──
// West to east: a 6–10 m tidal channel, flats charted to dry 1.2 m
// ("Hoogsand Flats", `flatM` wide), then either a harbour basin charted 1–2 m
// closed in by land, or (`landGap`) land where the flats were.
const M_LON_N = 111_320 * Math.cos((53.4 * Math.PI) / 180);
const CH_E = 5.3;
function wadden(flatM: number, opts: { landGap?: boolean; variant: number }): InshoreLayers {
    const FLAT_E = CH_E + flatM / M_LON_N;
    const BASIN_E = FLAT_E + 500 / M_LON_N;
    return {
        DEPARE: fc(
            depare(5.2, 53.38, CH_E, 53.42, 6, 10),
            ...(opts.landGap ? [] : [depare(CH_E, 53.38, FLAT_E, 53.42, -1.2, 0)]),
            depare(FLAT_E, 53.395, BASIN_E, 53.405, 1, 2),
        ),
        LNDARE: fc(
            ...(opts.landGap ? [land(CH_E, 53.38, FLAT_E, 53.42)] : []),
            land(FLAT_E, 53.38, 5.36, 53.395),
            land(FLAT_E, 53.405, 5.36, 53.42),
            land(BASIN_E, 53.395, 5.36, 53.405),
            ...specks(opts.variant, 5.21, 53.381),
        ),
        SEAARE: fc(rect(CH_E, 53.38, FLAT_E, 53.42, { OBJNAM: 'Hoogsand Flats' })),
    };
}
const waddenReq = (toLon: number, extra: Partial<RouteRequest>): RouteRequest => ({
    fromLat: 53.4,
    fromLon: 5.22,
    toLat: 53.4,
    toLon,
    draftM: 2.4,
    safetyM: 0.5,
    resolutionM: 50,
    ...extra,
});

describe('125-05b — a pin on drying sand: the route runs on to it, red and named (27° S, 40° W)', () => {
    let variant = 0;
    for (const policy of ['strict', 'permissive'] as const) {
        for (const tide of [null, 2.5, 3.5] as const) {
            const tideWords =
                tide === null
                    ? 'no tide data'
                    : tide === 2.5
                      ? 'a 2.5 m top (no tide floats it)'
                      : 'a 3.5 m top (a tide floats it)';
            it(`${policy}, ${tideWords}: reaches the pin across 180 m of sand, red, the tail named`, () => {
                const layers = island(++variant);
                const q = islandReq({
                    unchartedPolicy: policy,
                    ...(tide === null ? {} : { tideCeilings: ceilings(-27, -40, tide) }),
                });
                const r = routeInshore(layers, q);
                expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
                if (!isResult(r)) return;
                // Was: the route stopped at the deep water ~325 m short (base b42aed48).
                expect(endGap(r, q)).toBeLessThan(1);
                expect(r.pinOffWater).toEqual({ destination: 'drying' });
                expect(r.debug?.pinEdgeTrimM).toBeUndefined();
                const tail = pinRun(r, 'destination');
                expect(tail, JSON.stringify(r.dryRuns)).toBeDefined();
                expect(tail!.pin).toEqual({ end: 'destination', at: 'on' });
                expect(tail!.shallowestM).toBe(-0.4);
                expect(tail!.deepestM).toBe(0);
                expect(tail!.draftM).toBe(2.4);
                expect(tail!.needM).toBeCloseTo(2.9, 6);
                expect(tail!.lengthM).toBeGreaterThan(165);
                expect(tail!.lengthM).toBeLessThan(200);
                expect(tail!.tide).toEqual(tide === null ? null : { topM: tide, days: 14 });
                // The tail is the route's last stretch, and the only dry one.
                expect(tail!.endSeg).toBe(r.polyline.length - 2);
                expect(r.dryRuns).toHaveLength(1);
                // RED over the sand, whatever the tide — a 3.5 m top floats a
                // 2.4 m keel over it at high water, and it is still red.
                expect([...statesWhere(pieces(r, tide), onSand)]).toEqual(['danger']);
                // Charted depth behind the red: never "red with no depth".
                for (let i = tail!.startSeg; i <= tail!.endSeg; i++) {
                    expect(r.cautionMask?.[i], `seg ${i}`).toBe(true);
                    expect(r.chartedShallowMask?.[i], `seg ${i}`).toBe(true);
                    expect(r.tideDepthM?.[i], `seg ${i}`).toBeNull();
                }
                // Never across land, and only the sand to the pin dries.
                expect(auditUnvouchedHardLand(layers, r.polyline).maxRunM).toBe(0);
                expect(Math.abs(dryingM(layers, r.polyline) - 180)).toBeLessThan(15);
            });
        }
    }

    it('symmetrically, a departure from the sand starts at the pin, its first stretch red and named', () => {
        for (const tide of [null, 2.5] as const) {
            const layers = island(++variant);
            const q = islandReq({
                fromLon: PIN_SAND,
                toLon: -40.08,
                unchartedPolicy: 'strict',
                ...(tide === null ? {} : { tideCeilings: ceilings(-27, -40, tide) }),
            });
            const r = routeInshore(layers, q);
            expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
            if (!isResult(r)) continue;
            // Was: the route started at the sand's edge, 181–229 m off the pin.
            expect(startGap(r, q)).toBeLessThan(1);
            expect(r.pinOffWater).toEqual({ origin: 'drying' });
            const head = pinRun(r, 'origin');
            expect(head, JSON.stringify(r.dryRuns)).toBeDefined();
            expect(head!.pin).toEqual({ end: 'origin', at: 'on' });
            expect(head!.startSeg).toBe(0);
            expect(head!.lengthM).toBeGreaterThan(165);
            expect(head!.lengthM).toBeLessThan(200);
            expect([...statesWhere(pieces(r, tide), onSand)]).toEqual(['danger']);
            expect(r.cautionMask).toHaveLength(r.polyline.length - 1);
            expect(r.canalMask).toHaveLength(r.polyline.length - 1);
            expect(auditUnvouchedHardLand(layers, r.polyline).maxRunM).toBe(0);
        }
    });
});

describe('125-05b — land is never a dry tail', () => {
    let variant = 20;
    it('a pin on the island (charted land): the route still stops at the water’s edge, never on the sand', () => {
        for (const tide of [null, 2.5] as const) {
            const layers = island(++variant);
            const q = islandReq({
                toLon: -39.99,
                unchartedPolicy: 'strict',
                ...(tide === null ? {} : { tideCeilings: ceilings(-27, -40, tide) }),
            });
            const r = routeInshore(layers, q);
            expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
            if (!isResult(r)) continue;
            expect(r.pinOffWater).toEqual({ destination: 'land' });
            expect(r.dryRuns?.some((d) => d.pin) ?? false).toBe(false);
            expect(dryingM(layers, r.polyline)).toBeLessThan(1);
            expect(auditUnvouchedHardLand(layers, r.polyline).maxRunM).toBe(0);
            expect(endGap(r, q)).toBeGreaterThan(1000);
        }
    });

    it('a drying lagoon ringed by the island’s land: no tail across the land, the route stops at the edge', () => {
        const layers = island(++variant);
        const q = islandReq({ toLon: (LAGOON[0] + LAGOON[2]) / 2, unchartedPolicy: 'strict' });
        const r = routeInshore(layers, q);
        if (!isResult(r)) {
            // A refusal is honest too — but never for dry water.
            expect(r.code).not.toBe('no-tide-clears');
            return;
        }
        expect(r.pinOffWater).toEqual({ destination: 'drying' });
        expect(r.dryRuns?.some((d) => d.pin) ?? false).toBe(false);
        expect(auditUnvouchedHardLand(layers, r.polyline).maxRunM).toBe(0);
        expect(endGap(r, q)).toBeGreaterThan(500);
    });
});

describe('125-05b — the Wadden harbour (53.4° N, 5.3° E)', () => {
    let variant = 40;
    for (const tide of [null, 2.5] as const) {
        it(`a pin out on the flats, 1.5 km from the channel, ${tide === null ? 'no tide data' : 'a 2.5 m top'}: reached, the flats to it red and named`, () => {
            const layers = wadden(2000, { variant: ++variant });
            const pin = CH_E + 1500 / M_LON_N;
            const q = waddenReq(pin, {
                unchartedPolicy: 'strict',
                ...(tide === null ? {} : { tideCeilings: ceilings(53.4, 5.3, tide) }),
            });
            const r = routeInshore(layers, q);
            expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
            if (!isResult(r)) return;
            expect(endGap(r, q)).toBeLessThan(1);
            expect(r.pinOffWater).toEqual({ destination: 'drying' });
            // Never refused for its own flats as "the only way through" (review
            // fix-up, 2026-10-09: decision 11's reads of a finished route took
            // the pin's tail for a crossing).
            expect(r.debug?.noTideRefusal).toBeUndefined();
            const tail = pinRun(r, 'destination');
            expect(tail, JSON.stringify(r.dryRuns)).toBeDefined();
            expect(tail!.pin).toEqual({ end: 'destination', at: 'on' });
            expect(tail!.place).toBe('the Hoogsand Flats');
            expect(tail!.shallowestM).toBe(-1.2);
            expect(Math.abs(tail!.lengthM - 1500)).toBeLessThan(80);
            expect(tail!.tide).toEqual(tide === null ? null : { topM: 2.5, days: 14 });
            // Its position is in the north and east.
            expect(tail!.mid[0]).toBeGreaterThan(CH_E);
            expect(tail!.mid[1]).toBeGreaterThan(53);
            const flats = (lon: number, lat: number) =>
                lon > CH_E + 20 / M_LON_N && lon < pin && Math.abs(lat - 53.4) < 0.02;
            expect([...statesWhere(pieces(r, tide), flats)]).toEqual(['danger']);
            expect(auditUnvouchedHardLand(layers, r.polyline).maxRunM).toBe(0);
        });
    }

    for (const policy of ['strict', 'permissive'] as const) {
        for (const tide of [null, 2.5] as const) {
            it(`${policy}, ${tide === null ? 'no tide data' : 'a 2.5 m top'}: a harbour pin behind 800 m of flats is reached across them, red and named — no stop 1.3 km short`, () => {
                const layers = wadden(800, { variant: ++variant });
                const pin = CH_E + 850 / M_LON_N;
                const q = waddenReq(pin, {
                    unchartedPolicy: policy,
                    ...(tide === null ? {} : { tideCeilings: ceilings(53.4, 5.3, tide) }),
                });
                const r = routeInshore(layers, q);
                expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
                if (!isResult(r)) return;
                // Was: the route ended ~1,254 m short in the channel, no dry
                // stretch named — Auto refused it (base b42aed48).
                expect(endGap(r, q)).toBeLessThan(1);
                // The pin is water (the 1–2 m basin): not off the water.
                expect(r.pinOffWater).toBeUndefined();
                const flats = pinRun(r, 'destination');
                expect(flats, JSON.stringify(r.dryRuns)).toBeDefined();
                expect(flats!.pin).toEqual({ end: 'destination', at: 'beyond' });
                expect(flats!.place).toBe('the Hoogsand Flats');
                expect(flats!.shallowestM).toBe(-1.2);
                expect(Math.abs(flats!.lengthM - 800)).toBeLessThan(60);
                const onFlats = (lon: number, lat: number) =>
                    lon > CH_E + 20 / M_LON_N && lon < CH_E + 780 / M_LON_N && Math.abs(lat - 53.4) < 0.004;
                expect([...statesWhere(pieces(r, tide), onFlats)]).toEqual(['danger']);
                if (policy === 'strict') expect(auditUnvouchedHardLand(layers, r.polyline).maxRunM).toBe(0);
            });
        }
    }

    it('the same harbour behind 800 m of LAND: no tail across it — still no route by water', () => {
        for (const tide of [null, 2.5] as const) {
            const layers = wadden(800, { landGap: true, variant: ++variant });
            const q = waddenReq(CH_E + 850 / M_LON_N, {
                unchartedPolicy: 'strict',
                ...(tide === null ? {} : { tideCeilings: ceilings(53.4, 5.3, tide) }),
            });
            const r = routeInshore(layers, q);
            if (!isResult(r)) {
                expect(r.code).not.toBe('no-tide-clears');
                continue;
            }
            expect(r.dryRuns?.some((d) => d.pin) ?? false).toBe(false);
            expect(auditUnvouchedHardLand(layers, r.polyline).maxRunM).toBe(0);
            expect(endGap(r, q)).toBeGreaterThan(500);
        }
    });
});

// ── Review fix-up, 2026-10-09: the tail keeps to what the grid closes ──
// The tail was held to the chart's land, depth coverage, clearance bars and
// charted hazards only. Where the grid's own way to the pin was walled off
// by something else the grid closes — an OSM breakwater or coastline line,
// an OSM reef, a berth, a mark's keep-out — the straight line from the
// route's end was drawn instead, across it: probed on the island with a
// breakwater 60 m into the sand (the tail crossed it, and its words told the
// skipper which tide floats him over it) and with an OSM reef 40–120 m in
// (114 m of the tail inside the reef). A drying harbour inside its moles
// (the UK, France, the Wadden Sea) or a beach inside a fringing reef.
describe('125-05b review fix-up — a tail never crosses a breakwater or a reef the grid closes', () => {
    let variant = 60;
    /** A spot `x` m east of the sand's seaward edge and `y` m north of the pin. */
    const at = (x: number, y: number): [number, number] => [SAND_W + x / M_LON_S, ISL_LAT + y / 111_320];
    /** An OSM breakwater (the app merges its lines into COASTLINE) ringing the
     *  pin on the sand, 60–300 m in and 200 m either side — a drying harbour
     *  behind its moles; `gapM` opens its seaward side that wide. */
    const moles = (gapM = 0): Feature[] => {
        const line = (pts: [number, number][]): Feature => ({
            type: 'Feature',
            properties: { man_made: 'breakwater' },
            geometry: { type: 'LineString', coordinates: pts.map(([x, y]) => at(x, y)) },
        });
        if (gapM === 0)
            return [
                line([
                    [60, -200],
                    [300, -200],
                    [300, 200],
                    [60, 200],
                    [60, -200],
                ]),
            ];
        return [
            line([
                [60, gapM / 2],
                [60, 200],
                [300, 200],
                [300, -200],
                [60, -200],
                [60, -gapM / 2],
            ]),
        ];
    };
    /** An OSM reef (OBSTRN, no S-57 identity) ringing the pin on the sand, 40–320 m in. */
    const ringReef: Feature = {
        type: 'Feature',
        properties: { natural: 'reef', _class: 'osm-reef' },
        geometry: {
            type: 'Polygon',
            coordinates: [
                [at(40, -240), at(320, -240), at(320, 240), at(40, 240), at(40, -240)],
                [at(80, -200), at(80, 200), at(280, 200), at(280, -200), at(80, -200)],
            ],
        },
    };
    /** An OSM reef patch 40–120 m into the sand, 100 m either side of the pin's latitude. */
    const reefPatch = rect(...at(40, -100), ...at(120, 100), { natural: 'reef', _class: 'osm-reef' });
    /** Metres of a route inside an area (every ~2 m). */
    const insideM = (poly: readonly [number, number][], area: Polygon): number => {
        let m = 0;
        for (let i = 0; i + 1 < poly.length; i++) {
            const segM = hav(poly[i][1], poly[i][0], poly[i + 1][1], poly[i + 1][0]);
            const n = Math.max(1, Math.ceil(segM / 2));
            for (let k = 0; k < n; k++) {
                const t = (k + 0.5) / n;
                const lon = poly[i][0] + (poly[i + 1][0] - poly[i][0]) * t;
                const lat = poly[i][1] + (poly[i + 1][1] - poly[i][1]) * t;
                if (pointInGeometry(lon, lat, area)) m += segM / n;
            }
        }
        return m;
    };
    /** Does the route cross any of these lines? */
    const crosses = (poly: readonly [number, number][], lines: readonly Feature[]): boolean => {
        const side = (a: readonly number[], b: readonly number[], c: readonly number[]): number =>
            (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        for (const f of lines) {
            const c = (f.geometry as { coordinates: number[][] }).coordinates;
            for (let j = 0; j + 1 < c.length; j++)
                for (let i = 0; i + 1 < poly.length; i++) {
                    const [p, q] = [poly[i], poly[i + 1]];
                    if (
                        side(p, q, c[j]) * side(p, q, c[j + 1]) <= 0 &&
                        side(c[j], c[j + 1], p) * side(c[j], c[j + 1], q) <= 0
                    )
                        return true;
                }
        }
        return false;
    };

    for (const policy of ['strict', 'permissive'] as const) {
        for (const end of ['destination', 'origin'] as const) {
            const req = (tide: number | null): RouteRequest =>
                islandReq({
                    unchartedPolicy: policy,
                    ...(end === 'origin' ? { fromLon: PIN_SAND, toLon: -40.08 } : {}),
                    ...(tide === null ? {} : { tideCeilings: ceilings(-27, -40, tide) }),
                });
            const pinGap = (r: RouteResult, q: RouteRequest): number =>
                end === 'origin' ? startGap(r, q) : endGap(r, q);

            it(`${policy}, the ${end} pin inside a breakwater: no tail across it — the route stops at the water`, () => {
                for (const tide of [null, 2.5] as const) {
                    const layers: InshoreLayers = { ...island(++variant), COASTLINE: fc(...moles()) };
                    const q = req(tide);
                    const r = routeInshore(layers, q);
                    expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
                    if (!isResult(r)) continue;
                    // Was: a straight red tail across the breakwater to the pin.
                    expect(crosses(r.polyline, moles()), 'the route crosses the breakwater').toBe(false);
                    expect(r.dryRuns?.some((d) => d.pin) ?? false).toBe(false);
                    // Today's honest ending: short of the pin, "the route stops at its edge".
                    expect(r.pinOffWater).toEqual({ [end]: 'drying' });
                    expect(pinGap(r, q)).toBeGreaterThan(100);
                }
            });

            it(`${policy}, the ${end} pin inside a ring of OSM reef: no tail into the reef`, () => {
                for (const tide of [null, 2.5] as const) {
                    const layers: InshoreLayers = { ...island(++variant), OBSTRN: fc(ringReef) };
                    const q = req(tide);
                    const r = routeInshore(layers, q);
                    expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
                    if (!isResult(r)) continue;
                    // Was: the straight tail ran ~80 m through the reef.
                    expect(insideM(r.polyline, ringReef.geometry as Polygon)).toBe(0);
                    expect(r.dryRuns?.some((d) => d.pin) ?? false).toBe(false);
                    expect(r.pinOffWater).toEqual({ [end]: 'drying' });
                    expect(pinGap(r, q)).toBeGreaterThan(100);
                }
            });
        }

        it(`${policy}: the breakwater's entrance open — the tail goes in through it, never over the moles`, () => {
            for (const tide of [null, 2.5] as const) {
                const layers: InshoreLayers = { ...island(++variant), COASTLINE: fc(...moles(200)) };
                const q = islandReq({
                    unchartedPolicy: policy,
                    ...(tide === null ? {} : { tideCeilings: ceilings(-27, -40, tide) }),
                });
                const r = routeInshore(layers, q);
                expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
                if (!isResult(r)) continue;
                expect(endGap(r, q)).toBeLessThan(1);
                expect(pinRun(r, 'destination')?.pin).toEqual({ end: 'destination', at: 'on' });
                expect(crosses(r.polyline, moles(200))).toBe(false);
            }
        });

        it(`${policy}: a reef patch on the beach with a way round it — the tail goes round, never through`, () => {
            for (const tide of [null, 2.5] as const) {
                const layers: InshoreLayers = { ...island(++variant), OBSTRN: fc(reefPatch) };
                const q = islandReq({
                    unchartedPolicy: policy,
                    ...(tide === null ? {} : { tideCeilings: ceilings(-27, -40, tide) }),
                });
                const r = routeInshore(layers, q);
                expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
                if (!isResult(r)) continue;
                expect(endGap(r, q)).toBeLessThan(1);
                expect(pinRun(r, 'destination')?.pin).toEqual({ end: 'destination', at: 'on' });
                expect(insideM(r.polyline, reefPatch.geometry as Polygon)).toBe(0);
                expect(auditUnvouchedHardLand(layers, r.polyline).maxRunM).toBe(0);
            }
        });
    }
});

// ── Review fix-up, 2026-10-09: a pin's tail is no crossing to refuse for ──
// routeInshoreOnceEnds kept a pin's tail out of its own no-tide classifier,
// but the reads of a FINISHED route did not: the localized relax rescue's
// check (relaxedRescueFault), decision 11's verdict on today's route, its
// no-way-round check and the route through only what has no way round. With
// tide data loaded — the app's normal case online — a relaxed rescue that
// ended in a pin's dry tail was rejected for "crossing" the pin's own beach,
// and the strict route that stops kilometres short shipped instead (Shane's
// Newport canals → Tangalooma beach case, at grid alignments where the canal
// estate is cut off).
describe('125-05b review fix-up — the reads of a finished route leave its pins’ tails out', () => {
    it('a relaxed rescue that ends on the beach is no crossing of water no tide clears', () => {
        const layers = island(90);
        const q = islandReq({ unchartedPolicy: 'strict', tideCeilings: ceilings(-27, -40, 2.5) });
        const r = routeInshore(layers, q);
        expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
        if (!isResult(r)) return;
        expect(r.debug?.dryPinTail?.destination).toBeDefined();
        // Was: "crosses 186 m of water no tide clears" — the pin's own tail.
        expect(relaxedRescueFault(layers, q, r)).toBeNull();
        // The same line, not known as a tail: the sand is still water no tide
        // clears to that check — only a pin's own tail is left out.
        const { dryPinTail: _tail, ...debug } = r.debug!;
        expect(relaxedRescueFault(layers, q, { ...r, debug: debug as RouteResult['debug'] })).toMatch(
            /^crosses \d+ m of water no tide clears$/,
        );
    });

    it('so is a departure from the beach', () => {
        const layers = island(91);
        const q = islandReq({
            fromLon: PIN_SAND,
            toLon: -40.08,
            unchartedPolicy: 'strict',
            tideCeilings: ceilings(-27, -40, 2.5),
        });
        const r = routeInshore(layers, q);
        expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
        if (!isResult(r)) return;
        expect(r.debug?.dryPinTail?.origin).toBeDefined();
        expect(relaxedRescueFault(layers, q, r)).toBeNull();
    });

    // The 10 m marina pass cuts a tail into more segments than the 50 m pass
    // (probed at 53.4° N: 3 caution segments against 2, all on the tail), and
    // "no new caution" counted segments: a marina-to-beach route lost its fine
    // refinement to its own red tail.
    it('the fine pass is not refused for its own tail’s segments; caution elsewhere still refuses it', () => {
        const route = (caution: boolean[], tailSegs: number, distanceNM = 1.6): RouteResult =>
            ({
                polyline: Array.from({ length: caution.length + 1 }, (_, i) => [5.3 + i * 0.001, 53.4]),
                distanceNM,
                cautionMask: caution,
                debug: {
                    originSnap: { snapDistanceM: 6 },
                    destinationSnap: { snapDistanceM: 0 },
                    dryPinTail: {
                        destination: {
                            startSeg: caution.length - tailSegs,
                            endSeg: caution.length - 1,
                            at: 'on',
                            lengthM: 250,
                            snapM: 300,
                            segs: tailSegs,
                        },
                    },
                },
            }) as unknown as RouteResult;
        const q = waddenReq(5.31, {});
        const main = route([false, false, true, true], 2);
        // Was: refused, 3 caution segments against 2.
        expect(fineRefinementIsBetter(route([false, false, false, true, true, true], 3, 1.57), main, q)).toBe(true);
        // A caution segment outside the tail is still new caution.
        expect(fineRefinementIsBetter(route([false, true, false, true, true, true], 3, 1.57), main, q)).toBe(false);
    });
});
