/**
 * The synthetic archipelago (127-ROUTE-W): an INVENTED scene in open water at
 * 161.0E 20.3S, built in memory from a fixed seed. No real place, no real
 * chart: a jagged mainland with a breakwater marina, 26 islands with fringing
 * reefs and S-57-style banded depth areas, patch shoals, rocks, obstructions,
 * wrecks, lateral marks, soundings, contours and coastline lines, in three
 * cells at three scales (1:1.5M overview, 1:90k coastal, 1:12k harbour) sized
 * like real cells. The cell ids are fictional (`OC-99-SYN…`, the namespace
 * tests/noProtectedChartData.test.ts allows) and the producer is the
 * fictional `ZZ`.
 *
 * Ported from the 127 measurement's scene generator (scratch genScene.mjs,
 * 2026-10-10), so the routing timings measured there apply. Its routes run
 * from the marina basin to open-water anchorages about 5, 12 and 20 NM away.
 * Nothing is written to disk: a test calls `syntheticArchipelago()`.
 */
import type { Feature, FeatureCollection, Geometry } from 'geojson';

export type LonLat = [number, number];
type Bbox = [number, number, number, number];

export interface SyntheticCell {
    /** What EncCellMetadata lists for an installed cell. */
    meta: {
        id: string;
        sourceHO: string;
        edition: number;
        issued: string;
        importedAt: string;
        bbox: Bbox;
        geojsonPath: string;
        hazardCount: number;
        usage: 'navigation';
    };
    /** What EncCellStore.loadCellGeoJSON returns for it. */
    blob: {
        cellId: string;
        sourceHO: string;
        edition: number;
        issued: string;
        bbox: Bbox;
        nativeScale: number;
        layers: Record<string, FeatureCollection>;
    };
}

export interface SyntheticArchipelago {
    cells: SyntheticCell[];
    /** What the boat Pi's OSM overlay would hand back for the scene. */
    osm: Record<string, FeatureCollection>;
    routes: Record<'5nm' | '12nm' | '20nm', { from: LonLat; to: LonLat }>;
}

const LON0 = 161.0;
const LAT0 = -20.3;
const MLAT = 111_320;
const MLON = MLAT * Math.cos((LAT0 * Math.PI) / 180);
const ll = (x: number, y: number): LonLat => [+(LON0 + x / MLON).toFixed(7), +(LAT0 + y / MLAT).toFixed(7)];

interface Island {
    x: number;
    y: number;
    R: number;
    p1: number;
    p2: number;
    p3: number;
    n: number;
}

function build(): SyntheticArchipelago {
    let seed = 12345;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const between = (a: number, b: number): number => a + (b - a) * rnd();
    let rc = 1;
    const feat = (acronym: string, geometry: Geometry, props: Record<string, unknown> = {}, rcid = 0): Feature => ({
        type: 'Feature',
        properties: { acronym, rcid, ...props },
        geometry,
    });
    const poly = (...rings: LonLat[][]): Geometry => ({ type: 'Polygon', coordinates: rings });
    const line = (coords: LonLat[]): Geometry => ({ type: 'LineString', coordinates: coords });
    const point = (c: LonLat): Geometry => ({ type: 'Point', coordinates: c });

    // ── Mainland coast: x_c(y) = -18 km + noise, an inlet (marina) at y in [-160, 160] ──
    const E = 25_000;
    const coastX = (y: number): number =>
        -18_000 +
        500 * Math.sin(y / 2300) +
        260 * Math.sin(y / 700 + 1.3) +
        90 * Math.sin(y / 170 + 0.4) +
        35 * Math.sin(y / 47);
    const COAST_STEP = 30;
    const coastLine = (offset: number): [number, number][] => {
        const pts: [number, number][] = [];
        for (let y = -E; y <= E; y += COAST_STEP) pts.push([coastX(y) + offset, y]);
        return pts;
    };
    const MARINA = { y0: -160, y1: 160, depthIn: 450 };
    const marinaMouthX = coastX(0);

    const COAST_BANDS: [number, number, number, number][] = [
        [0, 90, -1.2, 0],
        [90, 260, 0, 2],
        [260, 520, 2, 5],
        [520, 950, 5, 10],
        [950, 1600, 10, 20],
    ];
    const strip = (d0: number, d1: number): LonLat[] => {
        const a = coastLine(d0);
        const b = coastLine(d1).reverse();
        return [...a, ...b, a[0]].map(([x, y]) => ll(x, y));
    };

    // ── Islands ──
    const islands: Island[] = [];
    const ISLAND_BANDS: [number, number, number, number][] = [
        [0, 80, -1.0, 0],
        [80, 220, 0, 2],
        [220, 420, 2, 5],
        [420, 750, 5, 10],
        [750, 1150, 10, 20],
    ];
    const OUTER = 1150;
    for (let tries = 0; islands.length < 26 && tries < 20_000; tries++) {
        const R = islands.length < 6 ? between(1800, 3200) : between(300, 1600);
        const x = between(-13_500, 22_000);
        const y = between(-21_500, 21_500);
        if (x - R * 1.4 - OUTER < coastX(y) + 1600 + 300) continue;
        if (Math.abs(x) + R * 1.4 + OUTER > E - 200 || Math.abs(y) + R * 1.4 + OUTER > E - 200) continue;
        const ok = islands.every((o) => Math.hypot(o.x - x, o.y - y) > o.R * 1.4 + R * 1.4 + 2 * OUTER + 500);
        if (!ok) continue;
        islands.push({
            x,
            y,
            R,
            p1: between(0, 6.28),
            p2: between(0, 6.28),
            p3: between(0, 6.28),
            n: Math.round(Math.min(420, Math.max(64, R / 9))),
        });
    }
    const islandR = (isl: Island, th: number): number =>
        isl.R *
        (1 + 0.22 * Math.sin(3 * th + isl.p1) + 0.12 * Math.sin(7 * th + isl.p2) + 0.05 * Math.sin(17 * th + isl.p3));
    const islandRing = (isl: Island, offset: number, nOverride?: number): LonLat[] => {
        const n = nOverride ?? isl.n;
        const ring: LonLat[] = [];
        for (let i = 0; i < n; i++) {
            const th = (2 * Math.PI * i) / n;
            const r = islandR(isl, th) + offset;
            ring.push(ll(isl.x + r * Math.cos(th), isl.y + r * Math.sin(th)));
        }
        ring.push(ring[0]);
        return ring;
    };

    // ── Patch shoals in the 20-30 m background ──
    const patches: { x: number; y: number; r: number; kind: 'shoal' | 'bommie' | 'patch' }[] = [];
    for (let tries = 0; patches.length < 170 && tries < 50_000; tries++) {
        const x = between(-16_000, 24_000);
        const y = between(-24_000, 24_000);
        const r = between(60, 320);
        if (x - r < coastX(y) + 1700) continue;
        if (Math.abs(x) + r > E - 100 || Math.abs(y) + r > E - 100) continue;
        if (islands.some((o) => Math.hypot(o.x - x, o.y - y) < o.R * 1.4 + OUTER + r + 150)) continue;
        if (patches.some((p) => Math.hypot(p.x - x, p.y - y) < p.r + r + 120)) continue;
        const kind = rnd() < 0.25 ? 'shoal' : rnd() < 0.15 ? 'bommie' : 'patch';
        patches.push({ x, y, r, kind });
    }
    const circle = (x: number, y: number, r: number, n = 24): LonLat[] => {
        const ring: LonLat[] = [];
        for (let i = 0; i < n; i++) {
            const th = (2 * Math.PI * i) / n;
            ring.push(ll(x + r * (1 + 0.15 * Math.sin(3 * th + x)) * Math.cos(th), y + r * Math.sin(th)));
        }
        ring.push(ring[0]);
        return ring;
    };
    const rectRing = (x0: number, y0: number, x1: number, y1: number): LonLat[] => [
        ll(x0, y0),
        ll(x1, y0),
        ll(x1, y1),
        ll(x0, y1),
        ll(x0, y0),
    ];
    const reversed = (ring: LonLat[]): LonLat[] => [...ring].reverse();

    // ── Coastal cell (1:90k) ──
    const coastalCell = (): Record<string, Feature[]> => {
        const L: Record<string, Feature[]> = {
            LNDARE: [],
            DEPARE: [],
            UWTROC: [],
            OBSTRN: [],
            WRECKS: [],
            BOYLAT: [],
            BCNLAT: [],
            BOYCAR: [],
            COALNE: [],
            DEPCNT: [],
            SOUNDG: [],
            M_QUAL: [],
            SEAARE: [],
            LIGHTS: [],
        };
        // At 1:90k the marina inlet is NOT drawn (land paint), as real coastal cells generalise it.
        const coast = coastLine(0).map(([x, y]) => ll(x, y));
        L.LNDARE.push(
            feat(
                'LNDARE',
                poly([ll(-E - 2000, -E), ...coast, ll(-E - 2000, E), ll(-E - 2000, -E)]),
                { OBJNAM: 'Mainland' },
                rc++,
            ),
        );
        L.COALNE.push(feat('COALNE', line(coast), { CATCOA: 1 }, rc++));
        for (const [d0, d1, v1, v2] of COAST_BANDS) {
            L.DEPARE.push(feat('DEPARE', poly(strip(d0, d1)), { DRVAL1: v1, DRVAL2: v2 }, rc++));
            L.DEPCNT.push(feat('DEPCNT', line(coastLine(d1).map(([x, y]) => ll(x, y))), { VALDCO: v2 }, rc++));
        }
        for (const [i, isl] of islands.entries()) {
            const coastRing = islandRing(isl, 0);
            L.LNDARE.push(feat('LNDARE', poly(coastRing), { OBJNAM: `Synthetic Island ${i + 1}` }, rc++));
            L.COALNE.push(feat('COALNE', line(coastRing), { CATCOA: 2 }, rc++));
            let inner = coastRing;
            for (const [, d1, v1, v2] of ISLAND_BANDS) {
                const outer = islandRing(isl, d1);
                L.DEPARE.push(feat('DEPARE', poly(outer, reversed(inner)), { DRVAL1: v1, DRVAL2: v2 }, rc++));
                L.DEPCNT.push(feat('DEPCNT', line(outer), { VALDCO: v2 }, rc++));
                inner = outer;
            }
            // Rocks on the fringing reef edge and in the 0-2 m band.
            const nr = Math.round(isl.R / 120);
            for (let k = 0; k < nr; k++) {
                const th = between(0, 6.28);
                const r = islandR(isl, th) + between(40, 260);
                L.UWTROC.push(
                    feat(
                        'UWTROC',
                        point(ll(isl.x + r * Math.cos(th), isl.y + r * Math.sin(th))),
                        { WATLEV: rnd() < 0.5 ? 4 : 3, VALSOU: +between(0, 1.5).toFixed(1) },
                        rc++,
                    ),
                );
            }
            L.SEAARE.push(
                feat('SEAARE', poly(islandRing(isl, OUTER, 24)), { OBJNAM: `Synthetic Sound ${i + 1}` }, rc++),
            );
        }
        // Background 20-30 m: the whole sea less every island's outer ring and every patch.
        const bgOuter: LonLat[] = [
            ...coastLine(1600).map(([x, y]) => ll(x, y)),
            ll(E, E),
            ll(E, -E),
            ll(coastX(-E) + 1600, -E),
        ];
        bgOuter.push(bgOuter[0]);
        const holes = [
            ...islands.map((isl) => reversed(islandRing(isl, OUTER))),
            ...patches.map((p) => reversed(circle(p.x, p.y, p.r + (p.kind === 'patch' ? 0 : 60)))),
        ];
        L.DEPARE.push(feat('DEPARE', poly(bgOuter, ...holes), { DRVAL1: 20, DRVAL2: 30 }, rc++));
        for (const p of patches) {
            if (p.kind === 'patch') {
                L.DEPARE.push(feat('DEPARE', poly(circle(p.x, p.y, p.r)), { DRVAL1: 5, DRVAL2: 10 }, rc++));
            } else {
                const core = circle(p.x, p.y, p.r);
                const rim = circle(p.x, p.y, p.r + 60);
                L.DEPARE.push(
                    feat(
                        'DEPARE',
                        poly(core),
                        p.kind === 'shoal' ? { DRVAL1: 2, DRVAL2: 5 } : { DRVAL1: -0.5, DRVAL2: 0 },
                        rc++,
                    ),
                );
                L.DEPARE.push(feat('DEPARE', poly(rim, reversed(core)), { DRVAL1: 5, DRVAL2: 10 }, rc++));
                if (p.kind === 'bommie')
                    L.UWTROC.push(feat('UWTROC', point(ll(p.x, p.y)), { WATLEV: 4, VALSOU: 0.3 }, rc++));
            }
        }
        // Obstructions and wrecks scattered in open water.
        for (let k = 0; k < 160; k++) {
            const x = between(-15_000, 24_000);
            const y = between(-24_000, 24_000);
            if (x < coastX(y) + 1700 || islands.some((o) => Math.hypot(o.x - x, o.y - y) < o.R * 1.4 + 300)) continue;
            L.OBSTRN.push(
                feat('OBSTRN', point(ll(x, y)), { CATOBS: 6, VALSOU: +between(2, 18).toFixed(1), WATLEV: 3 }, rc++),
            );
        }
        for (let k = 0; k < 24; k++) {
            const x = between(-15_000, 24_000);
            const y = between(-24_000, 24_000);
            if (x < coastX(y) + 1700) continue;
            L.OBSTRN.push(
                feat(
                    'OBSTRN',
                    poly(circle(x, y, between(40, 140), 12)),
                    { CATOBS: 5, VALSOU: +between(1, 8).toFixed(1), WATLEV: 3 },
                    rc++,
                ),
            );
            L.WRECKS.push(
                feat(
                    'WRECKS',
                    point(ll(x + 500, y - 400)),
                    { CATWRK: 2, VALSOU: +between(3, 15).toFixed(1), WATLEV: 3 },
                    rc++,
                ),
            );
        }
        // Soundings: dense multipoints, as real cells carry thousands.
        const snd: number[][] = [];
        for (let k = 0; k < 9000; k++) {
            const x = between(-17_000, 24_500);
            const y = between(-24_500, 24_500);
            if (x < coastX(y) + 30) continue;
            snd.push([...ll(x, y), +between(0.5, 30).toFixed(1)]);
        }
        for (let i = 0; i < snd.length; i += 300)
            L.SOUNDG.push(feat('SOUNDG', { type: 'MultiPoint', coordinates: snd.slice(i, i + 300) }, {}, rc++));
        // The marina approach laterals (also on the coastal chart).
        for (let k = 0; k < 6; k++) {
            const x = marinaMouthX + 150 + k * 200;
            L.BOYLAT.push(feat('BOYLAT', point(ll(x, 70)), { CATLAM: 2, OBJNAM: `Syn Channel ${2 * k + 1}` }, rc++));
            L.BOYLAT.push(feat('BOYLAT', point(ll(x, -70)), { CATLAM: 1, OBJNAM: `Syn Channel ${2 * k + 2}` }, rc++));
        }
        for (let k = 0; k < 8; k++) {
            const isl = islands[k];
            L.BCNLAT.push(
                feat(
                    'BCNLAT',
                    point(ll(isl.x + isl.R * 1.3 + 150, isl.y)),
                    { CATLAM: k % 2 ? 1 : 2, OBJNAM: `Syn Beacon ${k}` },
                    rc++,
                ),
            );
            L.BOYCAR.push(
                feat(
                    'BOYCAR',
                    point(ll(isl.x, isl.y - isl.R * 1.3 - 250)),
                    { CATCAM: 3, OBJNAM: `Syn South Cardinal ${k}` },
                    rc++,
                ),
            );
            L.LIGHTS.push(feat('LIGHTS', point(ll(isl.x, isl.y + isl.R * 0.3)), { COLOUR: '1', SIGPER: 5 }, rc++));
        }
        L.M_QUAL.push(feat('M_QUAL', poly(rectRing(-E, -E, E, E)), { CATZOC: 3 }, rc++));
        return L;
    };

    // ── Harbour cell (1:12k) round the marina: inlet, breakwaters, basin, dredged channel ──
    const HB = { x0: marinaMouthX - 1200, y0: -1500, x1: marinaMouthX + 2200, y1: 1500 };
    const harbourCell = (): Record<string, Feature[]> => {
        const L: Record<string, Feature[]> = {
            LNDARE: [],
            DEPARE: [],
            DRGARE: [],
            FAIRWY: [],
            BOYLAT: [],
            BCNLAT: [],
            COALNE: [],
            DEPCNT: [],
            SOUNDG: [],
            M_QUAL: [],
            OBSTRN: [],
            BRIDGE: [],
            CBLOHD: [],
            PIPOHD: [],
            CONVYR: [],
        };
        const fine: [number, number][] = [];
        for (let y = HB.y0; y <= HB.y1; y += 8) fine.push([coastX(y), y]);
        const south = fine.filter(([, y]) => y < MARINA.y0).map(([x, y]) => ll(x, y));
        const north = fine.filter(([, y]) => y > MARINA.y1).map(([x, y]) => ll(x, y));
        const inlet = [
            ll(coastX(MARINA.y0), MARINA.y0),
            ll(marinaMouthX - MARINA.depthIn, MARINA.y0),
            ll(marinaMouthX - MARINA.depthIn, MARINA.y1),
            ll(coastX(MARINA.y1), MARINA.y1),
        ];
        L.LNDARE.push(
            feat(
                'LNDARE',
                poly([ll(HB.x0, HB.y0), ...south, ...inlet, ...north, ll(HB.x0, HB.y1), ll(HB.x0, HB.y0)]),
                {},
                rc++,
            ),
        );
        L.COALNE.push(feat('COALNE', line([...south, ...inlet, ...north]), {}, rc++));
        // Breakwaters: two arms off the mouth leaving a 90 m gap.
        L.LNDARE.push(
            feat(
                'LNDARE',
                poly(rectRing(marinaMouthX - 10, MARINA.y1 - 10, marinaMouthX + 180, MARINA.y1 + 12)),
                { OBJNAM: 'North breakwater' },
                rc++,
            ),
        );
        L.LNDARE.push(
            feat(
                'LNDARE',
                poly(rectRing(marinaMouthX + 160, MARINA.y1 - 10, marinaMouthX + 182, -45)),
                { OBJNAM: 'East arm' },
                rc++,
            ),
        );
        // Basin and channel.
        L.DEPARE.push(
            feat(
                'DEPARE',
                poly(rectRing(marinaMouthX - MARINA.depthIn, MARINA.y0, marinaMouthX + 160, MARINA.y1 - 10)),
                { DRVAL1: 2.5, DRVAL2: 5 },
                rc++,
            ),
        );
        L.DRGARE.push(
            feat(
                'DRGARE',
                poly(rectRing(marinaMouthX + 182, -45, marinaMouthX + 1600, 45)),
                { DRVAL1: 4.0, OBJNAM: 'Syn Marina Channel' },
                rc++,
            ),
        );
        L.FAIRWY.push(
            feat(
                'FAIRWY',
                poly(rectRing(marinaMouthX + 182, -45, marinaMouthX + 1600, 45)),
                { OBJNAM: 'Syn Marina Channel' },
                rc++,
            ),
        );
        // Fine coastal bands (finer than the coastal cell's).
        for (const [d0, d1, v1, v2] of COAST_BANDS) {
            const a: LonLat[] = [];
            const b: LonLat[] = [];
            for (let y = HB.y0; y <= HB.y1; y += 8) {
                if (y > -60 && y < 60 && d0 < 1600) continue; // the channel corridor is the DRGARE's
                a.push(ll(coastX(y) + d0, y));
                b.push(ll(coastX(y) + d1, y));
            }
            L.DEPARE.push(feat('DEPARE', poly([...a, ...b.reverse(), a[0]]), { DRVAL1: v1, DRVAL2: v2 }, rc++));
        }
        L.DEPARE.push(
            feat('DEPARE', poly(rectRing(coastX(0) + 1600, HB.y0, HB.x1, HB.y1)), { DRVAL1: 10, DRVAL2: 20 }, rc++),
        );
        for (let k = 0; k < 7; k++) {
            const x = marinaMouthX + 260 + k * 190;
            L.BOYLAT.push(feat('BOYLAT', point(ll(x, 55)), { CATLAM: 2, OBJNAM: `Syn Channel ${2 * k + 1}` }, rc++));
            L.BCNLAT.push(feat('BCNLAT', point(ll(x, -55)), { CATLAM: 1, OBJNAM: `Syn Channel ${2 * k + 2}` }, rc++));
        }
        const snd: number[][] = [];
        for (let k = 0; k < 2500; k++) {
            const x = between(HB.x0, HB.x1);
            const y = between(HB.y0, HB.y1);
            if (x < coastX(y)) continue;
            snd.push([...ll(x, y), +between(0.5, 15).toFixed(1)]);
        }
        for (let i = 0; i < snd.length; i += 300)
            L.SOUNDG.push(feat('SOUNDG', { type: 'MultiPoint', coordinates: snd.slice(i, i + 300) }, {}, rc++));
        L.M_QUAL.push(feat('M_QUAL', poly(rectRing(HB.x0, HB.y0, HB.x1, HB.y1)), { CATZOC: 2 }, rc++));
        return L;
    };

    // ── Overview cell (1:1.5M): generalised land and one coarse band, bigger than the coastal cell ──
    const overviewCell = (): Record<string, Feature[]> => {
        const L: Record<string, Feature[]> = { LNDARE: [], DEPARE: [], COALNE: [] };
        const OE = 60_000;
        const coarse: LonLat[] = [];
        for (let y = -OE; y <= OE; y += 1500) coarse.push(ll(coastX(Math.max(-E, Math.min(E, y))) + 200, y));
        L.LNDARE.push(feat('LNDARE', poly([ll(-OE, -OE), ...coarse, ll(-OE, OE), ll(-OE, -OE)]), {}, rc++));
        const holes: LonLat[][] = [];
        for (const isl of islands.filter((i) => i.R > 900)) {
            const ring = islandRing(isl, 250, 12);
            L.LNDARE.push(feat('LNDARE', poly(ring), {}, rc++));
            holes.push(reversed(ring));
        }
        const outer = [...coarse, ll(OE, OE), ll(OE, -OE), coarse[0]];
        L.DEPARE.push(feat('DEPARE', poly(outer, ...holes), { DRVAL1: 20, DRVAL2: 50 }, rc++));
        return L;
    };

    const fcLayers = (L: Record<string, Feature[]>): Record<string, FeatureCollection> =>
        Object.fromEntries(Object.entries(L).map(([k, v]) => [k, { type: 'FeatureCollection', features: v }]));
    const bboxOf = (x0: number, y0: number, x1: number, y1: number): Bbox => [...ll(x0, y0), ...ll(x1, y1)];
    // Generated in the measured order (overview, coastal, harbour): the seed and the rcids follow it.
    const specs = [
        {
            cellId: 'OC-99-SYNOVR',
            nativeScale: 1_500_000,
            bbox: bboxOf(-60_000, -60_000, 60_000, 60_000),
            make: overviewCell,
        },
        { cellId: 'OC-99-SYNCST', nativeScale: 90_000, bbox: bboxOf(-E, -E, E, E), make: coastalCell },
        { cellId: 'OC-99-SYNHBR', nativeScale: 12_000, bbox: bboxOf(HB.x0, HB.y0, HB.x1, HB.y1), make: harbourCell },
    ];
    const cells: SyntheticCell[] = specs.map(({ cellId, nativeScale, bbox, make }) => {
        const layers = fcLayers(make());
        const featureCount = Object.values(layers).reduce((n, c) => n + c.features.length, 0);
        return {
            meta: {
                id: cellId,
                sourceHO: 'ZZ',
                edition: 1,
                issued: '2026-10-01',
                importedAt: '2026-10-01T00:00:00.000Z',
                bbox,
                geojsonPath: `enc/${cellId}.json`,
                hazardCount: featureCount * 20,
                usage: 'navigation',
            },
            blob: { cellId, sourceHO: 'ZZ', edition: 1, issued: '2026-10-01', bbox, nativeScale, layers },
        };
    });

    // ── Synthetic OSM overlay (what the Pi's Overpass cache would hand back) ──
    const osmFc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
    const osmF = (properties: Record<string, unknown>, geometry: Geometry): Feature => ({
        type: 'Feature',
        properties,
        geometry,
    });
    const osm: Record<string, FeatureCollection> = {
        water: osmFc([
            osmF(
                { leisure: 'marina', name: 'Syn Marina' },
                poly(rectRing(marinaMouthX - MARINA.depthIn, MARINA.y0, marinaMouthX + 160, MARINA.y1 - 10)),
            ),
        ]),
        marina: osmFc([
            osmF(
                { leisure: 'marina' },
                poly(rectRing(marinaMouthX - MARINA.depthIn, MARINA.y0, marinaMouthX + 180, MARINA.y1 + 12)),
            ),
        ]),
        reef: osmFc(islands.map((isl) => osmF({ natural: 'reef' }, poly(islandRing(isl, 90, 96))))),
        coastline: osmFc([
            osmF(
                { natural: 'coastline' },
                line(
                    coastLine(5)
                        .filter((_, i) => i % 2 === 0)
                        .map(([x, y]) => ll(x, y)),
                ),
            ),
            ...islands.map((isl) =>
                osmF({ natural: 'coastline' }, line(islandRing(isl, 5, Math.max(48, Math.round(isl.n / 2))))),
            ),
        ]),
        breakwater: osmFc([
            osmF(
                { man_made: 'breakwater' },
                line([ll(marinaMouthX, MARINA.y1), ll(marinaMouthX + 171, MARINA.y1), ll(marinaMouthX + 171, -45)]),
            ),
        ]),
        aeroway: osmFc([]),
        canalLines: osmFc([]),
        navLines: osmFc([]),
        berths: osmFc(
            Array.from({ length: 12 }, (_, k) =>
                osmF(
                    { man_made: 'pier', floating: 'yes' },
                    line([
                        ll(marinaMouthX - 420 + k * 35, MARINA.y0 + 20),
                        ll(marinaMouthX - 420 + k * 35, MARINA.y0 + 110),
                    ]),
                ),
            ),
        ),
    };

    // ── Routes: from the marina basin to anchorages ~5, ~12 and ~20 NM away, in 20-30 m water ──
    const ORIGIN = ll(marinaMouthX - 200, 0);
    const inWaterBg = (x: number, y: number): boolean =>
        x > coastX(y) + 1700 &&
        islands.every((o) => Math.hypot(o.x - x, o.y - y) > o.R * 1.4 + OUTER + 100) &&
        patches.every((p) => Math.hypot(p.x - x, p.y - y) > p.r + 200);
    const destAt = (nm: number, bearingDeg: number): LonLat => {
        for (let d = 0; d < 4000; d += 100) {
            for (const sgn of [1, -1]) {
                const b = ((bearingDeg + (sgn * d) / 100) * Math.PI) / 180;
                const r = nm * 1852;
                const x = marinaMouthX - 200 + r * Math.sin(b);
                const y = r * Math.cos(b);
                if (Math.abs(x) < E - 600 && Math.abs(y) < E - 600 && inWaterBg(x, y)) return ll(x, y);
            }
        }
        throw new Error(`no open-water anchorage ${nm} NM out`);
    };
    return {
        cells,
        osm,
        routes: {
            '5nm': { from: ORIGIN, to: destAt(5, 70) },
            '12nm': { from: ORIGIN, to: destAt(12, 95) },
            '20nm': { from: ORIGIN, to: destAt(20, 82) },
        },
    };
}

let cached: SyntheticArchipelago | null = null;

/**
 * The scene. Built once per test file (about 4 MB of JSON-equivalent); hand
 * out clones where a test or the router might change it.
 */
export function syntheticArchipelago(): SyntheticArchipelago {
    cached ??= build();
    return cached;
}
