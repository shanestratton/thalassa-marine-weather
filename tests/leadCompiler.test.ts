/**
 * Phase 1 (inshore router): the lead compiler — charted cells in, a typed,
 * directed lead graph out. Pinned on the real Newport cells (OC-61-10ENB5 +
 * OC-61-10RCS5) and the Moreton Bay corridor (four cells), plus synthetic
 * cases for the rules the fixtures do not exercise.
 *
 * Land here is measured independently of services/routing/leadLandClip.ts:
 * 5 m samples against the raw polygons with the engine's pointInGeometry.
 */
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from 'geojson';
import { beforeEach, describe, expect, it } from 'vitest';
import { geometryBbox, haversineM, pointInGeometry } from '../services/engine/geometry';
import {
    cachedLeadGraph,
    clearLeadGraphCache,
    compileLeadGraph,
    compileLeadSpans,
    LEAD_UKC_M,
    leadClass,
    leadDepthClass,
    leadClassSaveable,
    leadGraphOverlayGeoJSON,
    mergeLeadCells,
    type LeadCompilerLayers,
    type LeadEdge,
    type LeadGraph,
    type LeadSpan,
} from '../services/routing/leadCompiler';
import { catzocVerticalErrorM } from '../services/routing/leadReview';
import { CORRIDOR_CELL_SCALE, corridorCellRanks, withCorridorCellRanks } from './helpers/corridorCellRanks';
import { loadFixture } from './helpers/corridorFixture';
import { encCell } from './helpers/encCells';

// ── Fixtures ───────────────────────────────────────────────────────

type AnyLayers = Record<string, { features: Feature[] }>;

function extent(layers: AnyLayers): [number, number, number, number] {
    const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    const walk = (c: unknown): void => {
        if (!Array.isArray(c)) return;
        if (typeof c[0] === 'number') {
            b[0] = Math.min(b[0], c[0] as number);
            b[1] = Math.min(b[1], c[1] as number);
            b[2] = Math.max(b[2], c[0] as number);
            b[3] = Math.max(b[3], c[1] as number);
        } else for (const x of c) walk(x);
    };
    for (const l of Object.values(layers))
        for (const f of l.features ?? []) walk((f.geometry as { coordinates?: unknown })?.coordinates);
    return b;
}

const NEWPORT_IDS = ['OC-61-10ENB5', 'OC-61-10RCS5'];
// Each cell's scale as production knows it (the blob's compilation scale;
// here the fixture's usage band — tests/helpers/corridorCellRanks.ts).
const newportCells = NEWPORT_IDS.map((id) => {
    const c = encCell(id);
    return { id, bbox: extent(c.layers as AnyLayers), layers: c.layers, ...CORRIDOR_CELL_SCALE[id] };
});
/**
 * The same cells as if re-extracted with the structure layers (BRIDGE,
 * PONTON, CBLOHD, PIPOHD, CONVYR) carried empty — "extracted, none charted". The real
 * blobs carry none of them, and then nothing is clear (see "structures the
 * chart data cannot show" at the end); most of this file pins the OTHER
 * rules, so it reads the cells this way to keep them visible.
 */
const newportExtracted = newportCells.map((c) => ({
    ...c,
    layers: {
        ...c.layers,
        BRIDGE: { features: [] },
        PONTON: { features: [] },
        CBLOHD: { features: [] },
        PIPOHD: { features: [] },
        CONVYR: { features: [] },
    },
}));
const newport: LeadCompilerLayers = mergeLeadCells(newportExtracted);
const newportRaw = (layer: string): Feature[] => NEWPORT_IDS.flatMap((id) => encCell(id).layers[layer]?.features ?? []);

const moretonFx = loadFixture('moreton-bay-tier2.corridor.json.gz');
/** The capture as it is: no cell ids, no ranks — every band under land paint
 * is "rank unknown", so decision 1 leaves all of it land (fail safe). */
const moreton = moretonFx.cells as unknown as LeadCompilerLayers;
/** The same four cells ranked the way the router's merge ranks them
 * (tests/helpers/corridorCellRanks: each feature's cell recovered from the
 * capture's order): the production shape of this corridor. */
const moretonRanks = corridorCellRanks(moretonFx._meta.cells as string[], moretonFx.cells);
const moretonRanked = withCorridorCellRanks(moretonFx.cells, moretonRanks) as unknown as LeadCompilerLayers;

// ── Independent measures ───────────────────────────────────────────

interface Area {
    g: Polygon | MultiPolygon;
    b: [number, number, number, number];
}
const areas = (features: readonly Feature[], keep: (f: Feature) => boolean = () => true): Area[] =>
    features
        .filter((f) => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') && keep(f))
        .map((f) => ({
            g: f.geometry as Polygon | MultiPolygon,
            b: geometryBbox(f.geometry as Polygon | MultiPolygon),
        }));
const inAny = (list: readonly Area[], lon: number, lat: number): boolean =>
    list.some(({ g, b }) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3] && pointInGeometry(lon, lat, g));

/** Metres of a line inside `land` and not inside `water`, by 5 m interval midpoints. */
function metresOver(coords: readonly Position[], land: readonly Area[], water: readonly Area[] = []): number {
    let m = 0;
    for (let i = 0; i < coords.length - 1; i++) {
        const [lon0, lat0] = coords[i];
        const [lon1, lat1] = coords[i + 1];
        const segM = haversineM(lat0, lon0, lat1, lon1);
        const n = Math.max(1, Math.ceil(segM / 5));
        for (let s = 0; s < n; s++) {
            const t = (s + 0.5) / n;
            const lon = lon0 + (lon1 - lon0) * t;
            const lat = lat0 + (lat1 - lat0) * t;
            if (inAny(land, lon, lat) && !inAny(water, lon, lat)) m += segM / n;
        }
    }
    return m;
}

/** Distance (m) from a point to a polyline. */
function distToLineM(p: Position, line: readonly Position[]): number {
    const k = 111_320 * Math.cos((p[1] * Math.PI) / 180);
    let best = Infinity;
    for (let i = 0; i < line.length - 1; i++) {
        const ax = (line[i][0] - p[0]) * k;
        const ay = (line[i][1] - p[1]) * 110_540;
        const bx = (line[i + 1][0] - p[0]) * k;
        const by = (line[i + 1][1] - p[1]) * 110_540;
        const dx = bx - ax;
        const dy = by - ay;
        const l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
        best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
    return best;
}

const spansOf = (g: LeadGraph, rcid: number): LeadSpan[] => g.spans.filter((s) => s.rcids.includes(rcid));
const forward = (g: LeadGraph): LeadEdge[] => g.edges.filter((e) => e.id.endsWith('>'));

// ── Newport ────────────────────────────────────────────────────────

describe('lead compiler — Newport cells (OC-61-10ENB5 + OC-61-10RCS5)', () => {
    const g19 = compileLeadGraph(newport, 1.9);
    const g35 = compileLeadGraph(newport, 3.5);
    const rectrc = newportRaw('RECTRC');
    const navlne = newportRaw('NAVLNE');
    const rcidsWith = (key: 'CATNAV' | 'CATTRK', v: number, fs: Feature[]) =>
        fs.filter((f) => f.properties?.[key] === v).map((f) => f.properties?.rcid as number);

    it('reads the fixture it is pinned to: 18 RECTRC, 14 CATNAV 3, 5 CATNAV 1, 2 CATNAV 2', () => {
        expect(rectrc).toHaveLength(18);
        expect(rcidsWith('CATNAV', 3, navlne)).toHaveLength(14);
        expect(rcidsWith('CATNAV', 1, navlne).sort()).toEqual([2366, 2367, 2368, 2369, 2370]);
        expect(rcidsWith('CATNAV', 2, navlne).sort()).toEqual([2383, 3454]);
    });

    it('every recommended track becomes one whole, unclipped span', () => {
        const tracks = g19.spans.filter((s) => s.kind === 'recommended-track');
        expect(tracks).toHaveLength(18);
        expect(tracks.flatMap((s) => s.rcids).sort()).toEqual(rectrc.map((f) => f.properties?.rcid as number).sort());
        for (const s of tracks) {
            const src = rectrc.find((f) => f.properties?.rcid === s.rcids[0])!;
            const srcCoords = (src.geometry as { coordinates: Position[] }).coordinates;
            expect(s.sourceLandM).toBe(0);
            expect(s.coordinates).toEqual(srcCoords);
            expect(s.trust).toBe('chart');
        }
    });

    it('clearing lines (CATNAV 1) and transits (CATNAV 2) never become a lead edge', () => {
        const nonLeads = [...rcidsWith('CATNAV', 1, navlne), ...rcidsWith('CATNAV', 2, navlne)];
        for (const e of g19.edges) for (const r of nonLeads) expect(e.rcids).not.toContain(r);
        const leadRcids = new Set(g19.spans.filter((s) => s.kind === 'leading-line').flatMap((s) => s.rcids));
        for (const r of leadRcids) expect(rcidsWith('CATNAV', 3, navlne)).toContain(r);
    });

    it('each CATTRK 1 recommended track is the on-water span of a CATNAV 3 leading line', () => {
        const leads = navlne.filter((f) => f.properties?.CATNAV === 3);
        const cattrk1 = rectrc.filter((f) => f.properties?.CATTRK === 1);
        expect(cattrk1).toHaveLength(14);
        for (const t of cattrk1) {
            const tc = (t.geometry as { coordinates: Position[] }).coordinates;
            const host = leads.find((l) => {
                const lc = (l.geometry as { coordinates: Position[] }).coordinates;
                return tc.every((p) => distToLineM(p, lc) < 1);
            });
            expect(host, `RECTRC ${t.properties?.rcid} lies on a leading line`).toBeDefined();
        }
    });

    it('a leading line is not drawn again over its recommended track', () => {
        // NAVLNE 2372 IS RECTRC 2371 (same two nodes): no leading-line span.
        expect(spansOf(g19, 2372)).toHaveLength(0);
        expect(g19.dropped).toContainEqual({
            sourceId: 'NAVLNE OC-61-10ENB5 2372',
            reason: 'coincides-with-recommended-track',
        });
        const tracks = g19.spans.filter((s) => s.kind === 'recommended-track').map((s) => s.coordinates);
        const brg = (a: Position, b: Position) =>
            (Math.atan2((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]) * 180) / Math.PI;
        const parallel = (x: number, y: number) => {
            const d = Math.abs(x - y) % 180;
            return Math.min(d, 180 - d) < 3;
        };
        for (const s of g19.spans.filter((x) => x.kind === 'leading-line')) {
            // No stretch runs ALONG a track (near it and parallel to it); the
            // lines may only meet at a join.
            let alongM = 0;
            const c = s.coordinates;
            for (let i = 0; i < c.length - 1; i++) {
                const segM = haversineM(c[i][1], c[i][0], c[i + 1][1], c[i + 1][0]);
                const b = brg(c[i], c[i + 1]);
                const near = tracks.filter((tr) =>
                    tr.slice(1).some((q, j) => parallel(b, brg(tr[j], q)) && distToLineM(c[i], [tr[j], q]) < 50),
                );
                const n = Math.max(1, Math.ceil(segM / 5));
                for (let k = 0; k < n; k++) {
                    const t = (k + 0.5) / n;
                    const p: Position = [c[i][0] + (c[i + 1][0] - c[i][0]) * t, c[i][1] + (c[i + 1][1] - c[i][1]) * t];
                    if (near.some((tr) => distToLineM(p, tr) < 2)) alongM += segM / n;
                }
            }
            expect(alongM, s.id).toBeLessThan(5);
        }
    });

    it('clips the land-crossing leading lines 2379 (~1.1 km) and 2387 (~0.95 km) to water', () => {
        const land = areas(newportRaw('LNDARE'));
        for (const [rcid, landM] of [
            [2379, 1_096],
            [2387, 949],
        ] as const) {
            const raw = navlne.find((f) => f.properties?.rcid === rcid)!;
            const rawCoords = (raw.geometry as { coordinates: Position[] }).coordinates;
            // Independent: the raw line really does cross this much land.
            expect(metresOver(rawCoords, land)).toBeGreaterThan(landM - 25);
            const spans = spansOf(g19, rcid);
            expect(spans.length).toBeGreaterThan(0);
            for (const s of spans) {
                expect(s.kind).toBe('leading-line');
                expect(s.sourceLandM).toBeGreaterThan(landM - 10);
                expect(s.sourceLandM).toBeLessThan(landM + 10);
                expect(metresOver(s.coordinates, land)).toBe(0);
            }
        }
    });

    it('no compiled edge has any length over LNDARE', () => {
        const land = areas(newportRaw('LNDARE'));
        for (const s of g19.spans) expect(metresOver(s.coordinates, land), s.id).toBe(0);
        expect(g19.clippedLandM).toBeGreaterThan(4_000);
    });

    it('joins the recommended-track chain 2380~2382~2375~2378~2941~2918~2944 into one network', () => {
        const chain = [2380, 2382, 2375, 2378, 2941, 2918, 2944];
        const edgesOf = (rcid: number) =>
            g19.edges.filter((e) => e.kind === 'recommended-track' && e.rcids.includes(rcid));
        const nets = new Set(chain.flatMap((r) => edgesOf(r).map((e) => e.networkId)));
        expect(nets.size).toBe(1);
        // The joins the chart draws (S-57 shares these end points exactly):
        // 2382—2380—2375—2378—2941—2918—2944.
        const joins: [number, number][] = [
            [2380, 2382],
            [2375, 2380],
            [2375, 2378],
            [2378, 2941],
            [2918, 2941],
            [2918, 2944],
        ];
        for (const [x, y] of joins) {
            const a = new Set(edgesOf(x).flatMap((e) => [e.from, e.to]));
            expect(
                edgesOf(y)
                    .flatMap((e) => [e.from, e.to])
                    .some((n) => a.has(n)),
                `${x}~${y}`,
            ).toBe(true);
        }
        // The leading-line remnants hang off the same nodes.
        const net = g19.networks.find((n) => n.id === [...nets][0])!;
        expect(net.spanIds.some((id) => id.startsWith('leading-line:NAVLNE OC-61-10ENB5 2379'))).toBe(true);
    });

    it('every two-way lead is two directed edges, each the reverse of the other', () => {
        for (const s of g19.spans) expect(s.direction).toBe('both');
        expect(g19.edges).toHaveLength(g19.spans.length * 2);
        for (const e of forward(g19)) {
            const r = g19.edges.find((x) => x.id === e.reverseId)!;
            expect(r.reverseId).toBe(e.id);
            expect(r.coordinates).toEqual([...e.coordinates].reverse());
            expect([r.from, r.to]).toEqual([e.to, e.from]);
            const turn = (((r.bearingDeg - e.bearingDeg) % 360) + 360) % 360;
            expect(Math.abs(turn - 180)).toBeLessThan(0.5);
            expect(e.oneWay).toBe(false);
        }
        // RECTRC 2380 is charted at 255.5°: one of its two edges runs that way.
        const bearings = g19.edges.filter((e) => e.rcids.includes(2380)).map((e) => e.bearingDeg);
        expect(bearings.some((b) => Math.abs(b - 255.5) < 1.5)).toBe(true);
    });

    it('classes charted depth against a 1.9 m and a 3.5 m draft (0.5 m under the keel)', () => {
        const cls = (g: LeadGraph, rcid: number) =>
            forward(g).filter((e) => e.kind === 'recommended-track' && e.rcids.includes(rcid))[0].depth;
        // 9.1 m and 5 m tracks: deep enough for both keels. 2380 (CATZOC A1)
        // is clear. 2374 lies in a CATZOC C (4) survey zone. Owner decision 3
        // (2026-09-30) replaced the Phase 1 blanket "C is review": C's
        // vertical error is 2 m + 5% of the depth, so 5 m charted is 2.75 m
        // trusted — clear for a 1.9 m keel (needs 2.4 m), but not for 3.5 m
        // (needs 4.0 m): 'survey-margin'.
        for (const g of [g19, g35]) {
            expect(cls(g, 2380)).toMatchObject({ class: 'clear', minDepthM: 9.1, uncoveredM: 0, review: [] });
            expect(g.spans.find((s) => s.rcids.includes(2374))!.review.worstCatzoc).toBe(4);
            // A 2 m track and the 0 m Newport canal exit: charted, but needs tide.
            expect(cls(g, 2493)).toMatchObject({ class: 'needs-tide', minDepthM: 2 });
            expect(cls(g, 407)).toMatchObject({ class: 'needs-tide', minDepthM: 0 });
        }
        expect(cls(g19, 2374)).toMatchObject({ class: 'clear', minDepthM: 5, review: [] });
        expect(cls(g35, 2374)).toMatchObject({ class: 'needs-review', minDepthM: 5, review: ['survey-margin'] });
        const counts = (g: LeadGraph) =>
            forward(g).reduce<Record<string, number>>((m, e) => {
                const k = `${e.kind}:${e.depth.class}`;
                m[k] = (m[k] ?? 0) + 1;
                return m;
            }, {});
        // 18 tracks: 16 clear (2374's C zone leaves it margin enough at
        // 1.9 m, decision 3), 2 needs tide.
        expect(counts(g19)).toMatchObject({
            'recommended-track:clear': 16,
            'recommended-track:needs-tide': 2,
        });
        expect(counts(g19)['recommended-track:needs-review']).toBeUndefined();
        // A leading-line remnant with no charted depth under part of it is unknown, never clear.
        const unknown = forward(g19).filter((e) => e.depth.class === 'unknown');
        expect(unknown.length).toBeGreaterThan(0);
        for (const e of unknown) expect(e.depth.uncoveredM).toBeGreaterThan(1);
        // Deeper keel, same spans: 5 m tracks are no longer clear at 4.8 m (needs 5.3 m).
        const g48 = compileLeadGraph(newport, 4.8);
        expect(cls(g48, 2374).class).toBe('needs-tide');
        expect(cls(g48, 2380).class).toBe('clear');
    });

    it('compiles channel edges from the numbered lateral marks, two-way', () => {
        const channels = g19.spans.filter((s) => s.kind === 'channel');
        expect(channels.length).toBeGreaterThan(10);
        for (const s of channels) {
            expect(s.sourceIds[0]).toMatch(/^CHANNEL /);
            expect(s.direction).toBe('both');
        }
    });

    // Phase 1 review (medium): NAVLNE 2373 and 2920 are charted 5 m and read
    // 'clear', but pass 36 m and 45 m from OBSTRN 145 and 2627, which carry no
    // VALSOU (the depth over them is unknown) — inside the router's 60 m
    // obstruction buffer, where the router flags caution. The overlay showed
    // clear where the router shows red.
    it.each([
        [2373, 145, 36],
        [2920, 2627, 45],
    ])('NAVLNE %i passes OBSTRN %i (no VALSOU) at ~%i m: needs review, never clear', (rcid, obstrn, nearM) => {
        const raw = newportRaw('OBSTRN').find((f) => f.properties?.rcid === obstrn)!;
        // Independent: the obstruction really has no charted depth over it.
        expect(raw.properties?.VALSOU).toBeUndefined();
        const hit = forward(g19).filter(
            (e) =>
                e.rcids.includes(rcid) &&
                distToLineM((raw.geometry as { coordinates: Position }).coordinates, e.coordinates) < 60,
        );
        expect(hit.length).toBeGreaterThan(0);
        for (const e of hit) {
            expect(e.depth.class, e.id).toBe('needs-review');
            expect(e.depth.review).toContain('hazard');
            const span = g19.spans.find((s) => s.id === e.spanId)!;
            const h = span.review.hazards.find((x) => x.rcid === obstrn)!;
            expect(h).toMatchObject({ layer: 'OBSTRN', valsouM: null });
            expect(Math.abs(h.distanceM - nearM)).toBeLessThan(2);
        }
    });

    it('no clear edge passes an unknown or too-shallow charted hazard within 60 m, or lies in a CATZOC D/U or ungraded zone', () => {
        const hazards = ['OBSTRN', 'WRECKS', 'UWTROC'].flatMap((l) => newportRaw(l));
        const points = hazards.flatMap((f) => {
            const g = f.geometry;
            const v = f.properties?.VALSOU;
            const shallow = typeof v !== 'number' || v < 1.9 + 0.5;
            if (!shallow) return [];
            if (g.type === 'Point') return [g.coordinates];
            if (g.type === 'Polygon') return g.coordinates.flat();
            return [];
        });
        // The finest survey zone at a point (cell fineness from the merged
        // ranks); 0 where no zone covers it (not graded).
        const zones = (newport.M_QUAL?.features ?? []) as Feature[];
        const catzocAt = (lon: number, lat: number): number => {
            let bestRank = -Infinity;
            let worst = 0;
            for (const z of zones) {
                const g = z.geometry as Polygon | MultiPolygon;
                if (!pointInGeometry(lon, lat, g)) continue;
                const rank = Number(z.properties?._scaleRank);
                const c = Number(z.properties?.CATZOC);
                if (rank > bestRank) {
                    bestRank = rank;
                    worst = c;
                } else if (rank === bestRank) worst = Math.max(worst, c);
            }
            return worst;
        };
        const clear = forward(g19).filter((e) => e.depth.class === 'clear');
        expect(clear.length).toBeGreaterThan(20);
        let poorSurveyDemoted = 0;
        let clearInC = 0;
        for (const e of forward(g19)) {
            const c = e.coordinates;
            let poor = false;
            let inC = false;
            for (let i = 0; i < c.length - 1 && !poor; i++) {
                const n = Math.max(1, Math.ceil(haversineM(c[i][1], c[i][0], c[i + 1][1], c[i + 1][0]) / 10));
                // Interior samples only: an end point can sit on a zone edge.
                for (let k = 1; k < n && !poor; k++) {
                    const t = k / n;
                    const z = catzocAt(c[i][0] + (c[i + 1][0] - c[i][0]) * t, c[i][1] + (c[i + 1][1] - c[i][1]) * t);
                    if (z === 0 || z >= 5) poor = true;
                    if (z === 4) inC = true;
                }
            }
            if (poor) {
                expect(e.depth.class, e.id).not.toBe('clear');
                if (e.depth.review.some((r) => r === 'survey' || r === 'survey-ungraded')) poorSurveyDemoted++;
            }
            if (e.depth.class !== 'clear') continue;
            if (inC) clearInC++;
            for (const p of points) expect(distToLineM(p, e.coordinates), e.id).toBeGreaterThanOrEqual(58);
        }
        // Spans the chart surveys at CATZOC D/U really are demoted on this
        // fixture, and a C zone no longer demotes a lead with margin to spare.
        expect(poorSurveyDemoted).toBeGreaterThan(0);
        expect(clearInC).toBeGreaterThan(0);
    });
});

// ── Moreton ────────────────────────────────────────────────────────

describe('lead compiler — Moreton Bay corridor (four overlapping cells, merged)', () => {
    const g = compileLeadGraph(moreton, 1.9);
    const cells = moretonFx.cells as unknown as Record<string, FeatureCollection>;

    it('reads the fixture it is pinned to: 42 RECTRC, 38 NAVLNE', () => {
        expect(cells.RECTRC.features).toHaveLength(42);
        expect(cells.NAVLNE.features).toHaveLength(38);
    });

    it('no compiled edge has any length over hard land (LNDARE not charted as water)', () => {
        const land = areas(cells.LNDARE.features);
        const water = areas(
            [...cells.DEPARE.features, ...(cells.DRGARE?.features ?? []), ...(cells.FAIRWY?.features ?? [])],
            (f) => {
                const p = f.properties ?? {};
                return typeof p.acronym === 'string' && (p.acronym !== 'DEPARE' || Number(p.DRVAL1) > 0);
            },
        );
        for (const s of g.spans) expect(metresOver(s.coordinates, land, water), s.id).toBe(0);
        expect(g.clippedLandM).toBeGreaterThan(10_000);
    });

    it('a line charted in two overlapping cells is one span listing both records', () => {
        const twin = g.spans.find((s) => s.kind === 'recommended-track' && s.rcids.includes(2386));
        expect(twin?.rcids.sort()).toEqual([2386, 2784]);
        expect(g.dropped.filter((d) => d.reason === 'duplicate').length).toBeGreaterThanOrEqual(3);
        const keys = g.spans.map((s) => `${s.kind}|${JSON.stringify(s.coordinates)}`);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('never compiles a clearing line or a transit', () => {
        const nonLeads = cells.NAVLNE.features
            .filter((f) => f.properties?.CATNAV !== 3)
            .map((f) => f.properties?.rcid as number);
        expect(nonLeads).toHaveLength(8);
        for (const s of g.spans) for (const r of nonLeads) expect(s.rcids).not.toContain(r);
    });

    // Owner decision 1 (2026-09-30). RECTRC 2380 sits under the overview
    // cell's LNDARE and over ENB5's 9.1 m DEPARE. Phase 1 kept it whole and
    // could class it by depth alone; now a coarse chart's land paint over a
    // FINER survey's never-drying band is shallow water, never clear — and
    // only when the ranks show the band is finer.
    it('a track a coarse overview paints as land but a finer chart charts as water: needs tide, never clear', () => {
        const r = compileLeadGraph(moretonRanked, 1.9);
        const s = spansOf(r, 2380);
        expect(s).toHaveLength(1);
        expect(s[0].sourceLandM).toBe(0);
        expect(s[0].lengthM).toBeGreaterThan(1_500);
        // All of it is over the overview's land paint.
        expect(s[0].depth.landConflictM).toBeGreaterThan(1_500);
        const e = forward(r).find((x) => x.spanId === s[0].id)!;
        expect(e.depth).toMatchObject({ class: 'needs-tide', minDepthM: 9.1 });
        expect(e.depth.review[0]).toBe('land-paint');
        expect(
            leadGraphOverlayGeoJSON(r).features.find((f) => f.properties.spanId === s[0].id)!.properties.label,
        ).toMatch(/^Lead · needs tide · a coarser chart shows land/);
    });

    it('unranked (the capture as it is), the comparison cannot be made: the land paint stands', () => {
        expect(spansOf(g, 2380)).toHaveLength(0);
        expect(g.dropped).toContainEqual({ sourceId: 'RECTRC 2380', reason: 'on-land' });
    });

    it('the capture ranks as production ranks it (cells recovered from the capture order)', () => {
        // The router's rank (cellFinenessRank), from each cell's REAL
        // compilation scale read off the Pi's store (round 3, 2026-09-30;
        // tests/helpers/corridorCellRanks CORRIDOR_CELL_SCALE). RE-PIN
        // 1000 / 2000 / 4000 / 3000 → 1352 / 2382 / 5592 / 4505: the usage
        // bands were inferred from the extents, and two were a band out —
        // the Moreton cell is band 4 (1:90,000), the Brisbane harbour cell
        // band 5 (1:12,000). The same order, so nothing here moves with it
        // (round 2: 1000 / 2000 / 4000 / 3000; before that bbox ranks).
        expect(moretonRanks.rank).toEqual({
            'OC-61-051031': 1352, // the 30° × 30° overview, 1:3,000,000
            'OC-61-051032': 2382, // 1:1,500,000
            'OC-61-10ENB5': 5592, // the Brisbane harbour cell, 1:12,000
            'OC-61-351824': 4505, // the 1° × 1° Moreton cell, 1:90,000
        });
        // ENB5's LNDARE + DEPARE + DRGARE, matched whole: 65 + 552 + 43.
        expect(moretonRanks.counts['OC-61-10ENB5']).toBe(660);
        const total = ['LNDARE', 'DEPARE', 'DRGARE'].reduce((m, k) => m + (cells[k]?.features.length ?? 0), 0);
        expect(Object.values(moretonRanks.counts).reduce((m, n) => m + n, 0)).toBe(total);
    });

    it('ranked: no compiled edge has any length over land paint that no finer never-drying band beats', () => {
        const r = compileLeadGraph(moretonRanked, 1.9);
        const ranked = moretonRanked as unknown as Record<string, FeatureCollection>;
        const rankOf = (f: Feature) => Number(f.properties?._scaleRank);
        // Independent, 5 m samples: land unless the finest band there is
        // finer than every land claim and all its bands never dry.
        const withArea = (fs: Feature[]) => fs.flatMap((f) => areas([f]).map((a) => ({ f, ...a })));
        const land = withArea(ranked.LNDARE.features);
        const bands = withArea(
            [...ranked.DEPARE.features, ...(ranked.DRGARE?.features ?? [])].filter(
                (f) => typeof f.properties?.acronym === 'string',
            ),
        );
        const hardLandAt = (lon: number, lat: number): boolean => {
            const inLand = land.filter(
                ({ g: lg, b }) =>
                    lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3] && pointInGeometry(lon, lat, lg),
            );
            if (inLand.length === 0) return false;
            const landRank = Math.max(...inLand.map((a) => rankOf(a.f)));
            const here = bands.filter(
                ({ g: bg, b }) =>
                    lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3] && pointInGeometry(lon, lat, bg),
            );
            if (here.length === 0) return true;
            const top = Math.max(...here.map((a) => rankOf(a.f)));
            const owners = here.filter((a) => rankOf(a.f) === top);
            const neverDries = owners.every(
                (a) => typeof a.f.properties?.DRVAL1 === 'number' && a.f.properties.DRVAL1 >= 0,
            );
            return !(neverDries && top > landRank);
        };
        let conflictSpans = 0;
        for (const sp of r.spans) {
            const c = sp.coordinates;
            let m = 0;
            for (let i = 0; i < c.length - 1; i++) {
                const segM = haversineM(c[i][1], c[i][0], c[i + 1][1], c[i + 1][0]);
                const n = Math.max(1, Math.ceil(segM / 5));
                for (let k = 0; k < n; k++) {
                    const t = (k + 0.5) / n;
                    if (hardLandAt(c[i][0] + (c[i + 1][0] - c[i][0]) * t, c[i][1] + (c[i + 1][1] - c[i][1]) * t))
                        m += segM / n;
                }
            }
            // A 5 m sample can straddle a polygon edge the exact cut honours.
            expect(m, sp.id).toBeLessThan(10);
            if ((sp.depth.landConflictM ?? 0) > 1) conflictSpans++;
        }
        expect(conflictSpans).toBeGreaterThan(10);
    });

    // RE-PIN (D12 fix-up, 2026-10-03; owner decision 12, Shane: "Trust the
    // detailed chart"): ranked, the land paint over RECTRC 2655 is the
    // overview cells' only, over a detailed chart's never-drying 0 m band, so
    // it is no dispute any more (landConflictM 421 → 0, no 'land-paint'
    // review). It is still 'needs tide' — by its own charted 0 m.
    it("RECTRC 2655 lies wholly on the overview's land paint: dropped unranked; ranked, the detailed chart's own 0 m — needs tide, no dispute", () => {
        expect(spansOf(g, 2655)).toHaveLength(0);
        const r = compileLeadGraph(moretonRanked, 1.9);
        const s = spansOf(r, 2655);
        expect(s).toHaveLength(1);
        expect(s[0].depth.landConflictM ?? 0).toBe(0);
        expect(s[0].depth.minDepthM).toBe(0);
        const e = forward(r).find((x) => x.spanId === s[0].id)!;
        expect(e.depth.class).toBe('needs-tide');
        expect(e.depth.review).not.toContain('land-paint');
    });
});

// ── Synthetic rules ────────────────────────────────────────────────

const W = 152.1;
const S = -26.1;
const box = (x0: number, y0: number, x1: number, y1: number, props: Record<string, unknown>): Feature => ({
    type: 'Feature',
    properties: props,
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [W + x0, S + y0],
                [W + x1, S + y0],
                [W + x1, S + y1],
                [W + x0, S + y1],
                [W + x0, S + y0],
            ],
        ],
    },
});
const lineF = (coords: [number, number][], props: Record<string, unknown>): Feature => ({
    type: 'Feature',
    properties: props,
    geometry: { type: 'LineString', coordinates: coords.map(([x, y]) => [W + x, S + y]) },
});
const fc = (...features: Feature[]) => ({ type: 'FeatureCollection' as const, features });
const track = (coords: [number, number][], rcid: number, extra: Record<string, unknown> = {}) =>
    lineF(coords, { acronym: 'RECTRC', rcid, CATTRK: 1, TRAFIC: 4, ...extra });
const lead = (coords: [number, number][], rcid: number, CATNAV = 3) =>
    lineF(coords, { acronym: 'NAVLNE', rcid, CATNAV });
const deep = (x0: number, x1: number, d = 10, extra: Record<string, unknown> = {}) =>
    box(x0, -0.01, x1, 0.01, { acronym: 'DEPARE', DRVAL1: d, DRVAL2: d + 5, ...extra });
/** An A1 survey zone over every synthetic chart here. Without a graded
 * M_QUAL nothing is clear ('survey not graded', owner decision 4,
 * 2026-09-30); tests of the other rules carry one so 'clear' stays reachable. */
const GRADED = { M_QUAL: fc(box(-1, -1, 1, 1, { acronym: 'M_QUAL', CATZOC: 1 })) };
/** The structure layers carried empty — "extracted, none charted" — plus the
 * graded zone. A layer set without the structure layers is never clear (see
 * the end of this file); tests of the other rules carry them so 'clear' stays
 * reachable. */
const EXTRACTED = { BRIDGE: fc(), PONTON: fc(), CBLOHD: fc(), PIPOHD: fc(), CONVYR: fc(), ...GRADED };

describe('lead compiler — rules on synthetic charts', () => {
    it('cuts a leading line at the land and keeps both water runs', () => {
        const layers: LeadCompilerLayers = {
            LNDARE: fc(box(0.01, -0.01, 0.02, 0.01, { acronym: 'LNDARE' })),
            DEPARE: fc(deep(-0.01, 0.01), deep(0.02, 0.04)),
            NAVLNE: fc(
                lead(
                    [
                        [0, 0],
                        [0.03, 0],
                    ],
                    7,
                ),
            ),
        };
        const g = compileLeadGraph(layers, 2);
        const spans = spansOf(g, 7);
        expect(spans).toHaveLength(2);
        expect(spans[0].sourceLandM).toBeGreaterThan(990);
        expect(spans[0].sourceLandM).toBeLessThan(1_010);
        const land = areas(layers.LNDARE!.features as Feature[]);
        for (const s of spans) expect(metresOver(s.coordinates, land)).toBe(0);
        // A lead wholly ashore is dropped, and says why.
        const ashore = compileLeadGraph(
            {
                ...layers,
                NAVLNE: fc(
                    lead(
                        [
                            [0.012, 0],
                            [0.018, 0],
                        ],
                        8,
                    ),
                ),
            },
            2,
        );
        expect(ashore.spans).toHaveLength(0);
        expect(ashore.dropped).toEqual([{ sourceId: 'NAVLNE 8', reason: 'on-land' }]);
    });

    // Owner decision 1 (2026-09-30): only a FINER never-drying band beats the
    // land paint, so the land here is a coarse cell's (rank 100) and the
    // bands a finer one's (200) — and without ranks the land stands.
    it('a drying band under the land paint is still land; a finer never-drying band beats it', () => {
        const base = {
            LNDARE: fc(box(0.01, -0.01, 0.02, 0.01, { acronym: 'LNDARE', _scaleRank: 100 })),
            NAVLNE: fc(
                lead(
                    [
                        [0, 0],
                        [0.03, 0],
                    ],
                    7,
                ),
            ),
        };
        const band = (props: Record<string, unknown>) => fc(box(0.01, -0.01, 0.02, 0.01, props));
        const landUnder = (DEPARE: ReturnType<typeof fc>, layers: LeadCompilerLayers = base) =>
            spansOf(compileLeadGraph({ ...layers, DEPARE }, 2), 7)[0]?.sourceLandM ?? 0;
        expect(landUnder(band({ acronym: 'DEPARE', DRVAL1: -1, _scaleRank: 200 }))).toBeGreaterThan(990);
        const wet = compileLeadGraph({ ...base, DEPARE: band({ acronym: 'DEPARE', DRVAL1: 3, _scaleRank: 200 }) }, 2);
        expect(spansOf(wet, 7)).toHaveLength(1);
        expect(spansOf(wet, 7)[0].sourceLandM).toBe(0);
        // DRVAL1 0 never dries (the decision says ≥ 0).
        expect(landUnder(band({ acronym: 'DEPARE', DRVAL1: 0, _scaleRank: 200 }))).toBe(0);
        // …nor does a finer dredged area; one with no DRVAL1 is not evidence.
        const drg = (props: Record<string, unknown>) =>
            spansOf(compileLeadGraph({ ...base, DRGARE: band({ acronym: 'DRGARE', ...props }) }, 2), 7)[0].sourceLandM;
        expect(drg({ DRVAL1: 4, _scaleRank: 200 })).toBe(0);
        expect(drg({ _scaleRank: 200 })).toBeGreaterThan(990);
        // A band at the SAME scale as the land paint does not beat it.
        expect(landUnder(band({ acronym: 'DEPARE', DRVAL1: 3, _scaleRank: 100 }))).toBeGreaterThan(990);
        // Unknown ranks fail safe: the land paint stands.
        expect(landUnder(band({ acronym: 'DEPARE', DRVAL1: 3 }))).toBeGreaterThan(990);
        const unrankedLand = { ...base, LNDARE: fc(box(0.01, -0.01, 0.02, 0.01, { acronym: 'LNDARE' })) };
        expect(landUnder(band({ acronym: 'DEPARE', DRVAL1: 3, _scaleRank: 200 }), unrankedLand)).toBeGreaterThan(990);
        // A chart fairway carries no depth: not water under land paint.
        expect(
            spansOf(
                compileLeadGraph(
                    { ...base, FAIRWY: band({ acronym: 'FAIRWY', _scaleRank: 200 }) } as LeadCompilerLayers,
                    2,
                ),
                7,
            )[0].sourceLandM,
        ).toBeGreaterThan(990);
        // Injected OSM water (no S-57 identity) is not chart evidence.
        expect(landUnder(band({ DRVAL1: 10, water: 'river', _scaleRank: 200 }))).toBeGreaterThan(990);
    });

    it('coarse chart water never erases a finer cell’s land (scale rank)', () => {
        const island = box(0.01, -0.01, 0.02, 0.01, { acronym: 'LNDARE', _scaleRank: 200 });
        const coarseWater = box(-0.05, -0.05, 0.05, 0.05, { acronym: 'DEPARE', DRVAL1: 20, _scaleRank: 100 });
        const g = compileLeadGraph(
            {
                LNDARE: fc(island),
                DEPARE: fc(coarseWater),
                NAVLNE: fc(
                    lead(
                        [
                            [0, 0],
                            [0.03, 0],
                        ],
                        7,
                    ),
                ),
            },
            2,
        );
        expect(spansOf(g, 7)).toHaveLength(2);
        expect(spansOf(g, 7)[0].sourceLandM).toBeGreaterThan(990);
        // …while a finer survey's water does beat a coarse overview's land paint.
        const overviewLand = box(0.01, -0.01, 0.02, 0.01, { acronym: 'LNDARE', _scaleRank: 100 });
        const fineWater = box(-0.05, -0.05, 0.05, 0.05, { acronym: 'DEPARE', DRVAL1: 20, _scaleRank: 200 });
        const h = compileLeadGraph(
            {
                LNDARE: fc(overviewLand),
                DEPARE: fc(fineWater),
                NAVLNE: fc(
                    lead(
                        [
                            [0, 0],
                            [0.03, 0],
                        ],
                        7,
                    ),
                ),
            },
            2,
        );
        expect(spansOf(h, 7)).toHaveLength(1);
        expect(spansOf(h, 7)[0].sourceLandM).toBe(0);
        // Decision 1: that water is shallow water, never clear — 20 m deep by
        // the finer band, but the coarse chart draws land: 'needs tide'.
        expect(spansOf(h, 7)[0].depth.landConflictM).toBeGreaterThan(990);
        expect(h.edges[0].depth).toMatchObject({ class: 'needs-tide', minDepthM: 20 });
        expect(h.edges[0].depth.review[0]).toBe('land-paint');
    });

    it('classes depth: clear, needs tide, unknown', () => {
        const layers: LeadCompilerLayers = {
            ...EXTRACTED,
            DEPARE: fc(deep(-0.01, 0.02, 3)),
            RECTRC: fc(
                track(
                    [
                        [0, 0],
                        [0.01, 0],
                    ],
                    1,
                ),
                track(
                    [
                        [0.01, 0],
                        [0.03, 0],
                    ],
                    2,
                ),
            ),
        };
        const at = (draft: number, rcid: number) => spansOf(compileLeadGraph(layers, draft), rcid)[0];
        const e19 = compileLeadGraph(layers, 1.9).edges.find((e) => e.rcids.includes(1))!;
        expect(e19.depth).toEqual({ minDepthM: 3, uncoveredM: 0, landConflictM: 0, class: 'clear', review: [] });
        expect(compileLeadGraph(layers, 3.5).edges.find((e) => e.rcids.includes(1))!.depth.class).toBe('needs-tide');
        // Track 2 runs 1 km past the charted band: unknown at any draft.
        expect(at(1.9, 2).depth.uncoveredM).toBeGreaterThan(990);
        for (const d of [1.9, 3.5]) {
            expect(compileLeadGraph(layers, d).edges.find((e) => e.rcids.includes(2))!.depth.class).toBe('unknown');
        }
        expect(leadDepthClass({ minDepthM: null, uncoveredM: 0 }, 1)).toBe('unknown');
        expect(leadDepthClass({ minDepthM: 2.4, uncoveredM: 0 }, 1.9)).toBe('clear');
        expect(leadDepthClass({ minDepthM: 2.39, uncoveredM: 0 }, 1.9)).toBe('needs-tide');
        // Water over a coarser chart's land paint (decision 1) is never clear.
        expect(leadDepthClass({ minDepthM: 20, uncoveredM: 0, landConflictM: 50 }, 1.9)).toBe('needs-tide');
        expect(leadDepthClass({ minDepthM: 20, uncoveredM: 0, landConflictM: 0.5 }, 1.9)).toBe('clear');
    });

    it('finest survey wins the charted depth; DRGARE counts as charted depth', () => {
        const coarse = deep(-0.02, 0.02, 1, { _scaleRank: 100 });
        const fine = deep(-0.02, 0.02, 6, { _scaleRank: 200 });
        const g = compileLeadGraph(
            {
                ...EXTRACTED,
                DEPARE: fc(coarse, fine),
                RECTRC: fc(
                    track(
                        [
                            [0, 0],
                            [0.01, 0],
                        ],
                        1,
                    ),
                ),
            },
            2,
        );
        expect(g.edges[0].depth).toMatchObject({ minDepthM: 6, class: 'clear' });
        const dredged = box(-0.02, -0.01, 0.02, 0.01, { acronym: 'DRGARE', DRVAL1: 4 });
        const h = compileLeadGraph(
            {
                ...EXTRACTED,
                DRGARE: fc(dredged),
                RECTRC: fc(
                    track(
                        [
                            [0, 0],
                            [0.01, 0],
                        ],
                        1,
                    ),
                ),
            },
            2,
        );
        expect(h.edges[0].depth).toMatchObject({ minDepthM: 4, class: 'clear' });
    });

    // Phase 1 review (high): a finer survey's band with NO DRVAL1 was skipped,
    // so the track fell through to a coarser cell's 10 m band and read
    // 'clear'. The finest covering survey owns the depth (the grid's rule);
    // where it charts no depth the depth is unknown, never a coarser guess.
    it.each([
        ['DRGARE', { acronym: 'DRGARE' }],
        ['DEPARE', { acronym: 'DEPARE' }],
    ])('a finer %s with no DRVAL1 makes the depth unknown, not the coarser cell’s 10 m', (layer, props) => {
        const sq = (x0: number, y0: number, x1: number, y1: number) => ({
            type: 'Polygon' as const,
            coordinates: [
                [
                    [x0, y0],
                    [x1, y0],
                    [x1, y1],
                    [x0, y1],
                    [x0, y0],
                ],
            ],
        });
        const X = 149.1;
        const Y = -21.1;
        const coarse = {
            id: 'COARSE',
            bbox: [X - 0.5, Y - 0.5, X + 0.5, Y + 0.5] as [number, number, number, number],
            layers: {
                DEPARE: {
                    features: [
                        {
                            type: 'Feature',
                            properties: { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 20 },
                            geometry: sq(X - 0.5, Y - 0.5, X + 0.5, Y + 0.5),
                        },
                    ],
                },
            },
        };
        const fineCell = (bandProps: Record<string, unknown>, bandLayer: string) => ({
            id: 'FINE',
            bbox: [X, Y, X + 0.1, Y + 0.1] as [number, number, number, number],
            layers: {
                [bandLayer]: {
                    features: [{ type: 'Feature', properties: bandProps, geometry: sq(X, Y, X + 0.1, Y + 0.1) }],
                },
                RECTRC: {
                    features: [
                        {
                            type: 'Feature',
                            properties: { acronym: 'RECTRC', rcid: 1, CATTRK: 1, TRAFIC: 4 },
                            geometry: {
                                type: 'LineString',
                                coordinates: [
                                    [X + 0.01, Y + 0.05],
                                    [X + 0.09, Y + 0.05],
                                ],
                            },
                        },
                    ],
                },
            },
        });
        const classOf = (fine: ReturnType<typeof fineCell>) =>
            compileLeadGraph(mergeLeadCells([coarse, fine]), 2).edges[0].depth;
        const undepthed = classOf(fineCell(props, layer));
        expect(undepthed.class).toBe('unknown');
        expect(undepthed.minDepthM).toBeNull();
        expect(undepthed.uncoveredM).toBeGreaterThan(8_000);
        // Control: the same fine band charted at 1 m owns the depth → needs tide.
        expect(classOf(fineCell({ ...props, DRVAL1: 1 }, layer))).toMatchObject({ class: 'needs-tide', minDepthM: 1 });
    });

    it('a one-way track is one edge in its ORIENT direction; without ORIENT it is flagged', () => {
        const eastward = track(
            [
                [0, 0],
                [0.01, 0],
            ],
            1,
            { TRAFIC: 3, ORIENT: 90 },
        );
        const westward = track(
            [
                [0, 0.005],
                [0.01, 0.005],
            ],
            2,
            { TRAFIC: 3, ORIENT: 270 },
        );
        const unknownDir = track(
            [
                [0, -0.005],
                [0.01, -0.005],
            ],
            3,
            { TRAFIC: 1 },
        );
        const g = compileLeadGraph({ DEPARE: fc(deep(-0.02, 0.03)), RECTRC: fc(eastward, westward, unknownDir) }, 2);
        const e1 = g.edges.filter((e) => e.rcids.includes(1));
        expect(e1).toHaveLength(1);
        expect(e1[0].oneWay).toBe(true);
        expect(Math.abs(e1[0].bearingDeg - 90)).toBeLessThan(1);
        const e2 = g.edges.filter((e) => e.rcids.includes(2));
        expect(e2).toHaveLength(1);
        expect(Math.abs(e2[0].bearingDeg - 270)).toBeLessThan(1);
        const e3 = g.edges.filter((e) => e.rcids.includes(3));
        expect(e3).toHaveLength(2);
        expect(e3.every((e) => e.directionUnresolved === true)).toBe(true);
    });

    it('tracks sharing an end point join; a track apart is its own network', () => {
        const g = compileLeadGraph(
            {
                DEPARE: fc(deep(-0.02, 0.1)),
                RECTRC: fc(
                    track(
                        [
                            [0, 0],
                            [0.01, 0],
                        ],
                        1,
                    ),
                    track(
                        [
                            [0.01, 0],
                            [0.02, 0.005],
                        ],
                        2,
                    ),
                    track(
                        [
                            [0.05, 0],
                            [0.06, 0],
                        ],
                        3,
                    ),
                ),
            },
            2,
        );
        expect(g.nodes).toHaveLength(5);
        const net = (r: number) => g.edges.find((e) => e.rcids.includes(r))!.networkId;
        expect(net(1)).toBe(net(2));
        expect(net(3)).not.toBe(net(1));
        expect(g.networks).toHaveLength(2);
    });

    it('OSM leading lines are compiled only when given, as trust osm, never over a chart lead', () => {
        const osm = (coords: [number, number][], id: number) =>
            lineF(coords, {
                'seamark:type': 'navigation_line',
                'seamark:navigation_line:category': 'leading',
                _source: 'osm',
                rcid: undefined,
                '@id': `way/${id}`,
            });
        const layers: LeadCompilerLayers = {
            DEPARE: fc(deep(-0.02, 0.05)),
            RECTRC: fc(
                track(
                    [
                        [0, 0],
                        [0.01, 0],
                    ],
                    1,
                ),
            ),
        };
        const osmLines = [
            osm(
                [
                    [0, 0],
                    [0.01, 0],
                ],
                11,
            ),
            osm(
                [
                    [0, 0.005],
                    [0.02, 0.005],
                ],
                12,
            ),
        ];
        expect(compileLeadGraph(layers, 2).spans.every((s) => s.trust === 'chart')).toBe(true);
        const g = compileLeadGraph(layers, 2, { osmNavLines: osmLines });
        const osmSpans = g.spans.filter((s) => s.trust === 'osm');
        expect(osmSpans).toHaveLength(1);
        expect(osmSpans[0].kind).toBe('leading-line');
        expect(g.dropped).toContainEqual({ sourceId: 'OSM way/11', reason: 'coincides-with-recommended-track' });
        // An OSM clearing or transit line is not a lead.
        const other = lineF(
            [
                [0, -0.005],
                [0.02, -0.005],
            ],
            {
                'seamark:type': 'navigation_line',
                'seamark:navigation_line:category': 'clearing',
            },
        );
        expect(compileLeadGraph(layers, 2, { osmNavLines: [other] }).spans.some((s) => s.trust === 'osm')).toBe(false);
    });

    // Phase 1 review (medium): 'clear' used to mean only "DRVAL1 ≥ draft +
    // 0.5 m". The contract now: clear also means no charted obstruction of
    // unknown or too-shallow depth within the router's 60 m obstruction
    // buffer, no bridge / shoreline construction / pontoon on the line, and
    // no CATZOC C, D or U survey under it. Any of those demotes a deep lead
    // to 'needs-review' (never green) and says why; a shallow one stays
    // 'needs-tide' with the reasons listed.
    describe('the clear contract: hazards, structures and survey quality', () => {
        const base: LeadCompilerLayers = {
            ...EXTRACTED,
            DEPARE: fc(deep(-0.02, 0.05)),
            RECTRC: fc(
                track(
                    [
                        [0, 0],
                        [0.02, 0],
                    ],
                    1,
                ),
            ),
        };
        const dLat = (m: number) => m / 110_540;
        const pt = (x: number, y: number, props: Record<string, unknown>): Feature => ({
            type: 'Feature',
            properties: props,
            geometry: { type: 'Point', coordinates: [W + x, S + y] },
        });
        const depthOf = (extra: Partial<LeadCompilerLayers>, layers: LeadCompilerLayers = base) =>
            compileLeadGraph({ ...layers, ...extra }, 2).edges.find((e) => e.rcids.includes(1))!.depth;

        it('control: a deep track with nothing charted near it is clear, with no reasons', () => {
            expect(depthOf({})).toMatchObject({ class: 'clear', review: [] });
        });

        it('an obstruction of unknown or too-shallow depth within 60 m demotes it; a deep or distant one does not', () => {
            expect(
                depthOf({ OBSTRN: fc(pt(0.01, dLat(30), { acronym: 'OBSTRN', rcid: 9, WATLEV: 3 })) }),
            ).toMatchObject({ class: 'needs-review', review: ['hazard'] });
            expect(depthOf({ WRECKS: fc(pt(0.01, dLat(45), { acronym: 'WRECKS', VALSOU: 1.5 })) }).class).toBe(
                'needs-review',
            );
            // 8 m over a rock is deeper than 2 m + 0.5 m: no concern.
            expect(depthOf({ UWTROC: fc(pt(0.01, dLat(20), { acronym: 'UWTROC', VALSOU: 8 })) })).toMatchObject({
                class: 'clear',
                review: [],
            });
            // 100 m off the line, outside the 60 m buffer.
            expect(depthOf({ OBSTRN: fc(pt(0.01, dLat(100), { acronym: 'OBSTRN' })) }).class).toBe('clear');
            // An area obstruction the track runs through.
            expect(
                depthOf({ OBSTRN: fc(box(0.009, -0.0002, 0.011, 0.0002, { acronym: 'OBSTRN', rcid: 11 })) }).class,
            ).toBe('needs-review');
            const span = compileLeadGraph(
                { ...base, OBSTRN: fc(pt(0.01, dLat(30), { acronym: 'OBSTRN', rcid: 9 })) },
                2,
            ).spans[0];
            expect(span.review.hazards).toHaveLength(1);
            expect(span.review.hazards[0]).toMatchObject({ layer: 'OBSTRN', rcid: 9, valsouM: null });
            expect(span.review.hazards[0].distanceM).toBeGreaterThan(28);
            expect(span.review.hazards[0].distanceM).toBeLessThan(32);
        });

        it('a bridge, a shoreline construction or a pontoon on the line demotes it', () => {
            const across = (layer: string) =>
                lineF(
                    [
                        [0.01, -0.001],
                        [0.01, 0.001],
                    ],
                    { acronym: layer, rcid: 3 },
                );
            // No clearance charted and no air draft given: it blocks a mast
            // (Part B, owner decisions) — 'bridge clearance', and the air
            // draft the classifier had nothing to check against. Blocked,
            // not amber (owner decision 5; round 2, 2026-09-30).
            expect(depthOf({ BRIDGE: fc(across('BRIDGE')) })).toMatchObject({
                class: 'blocked',
                review: ['bridge-clearance', 'air-draft-not-set'],
            });
            expect(depthOf({ SLCONS: fc(box(0.009, -0.0005, 0.011, 0.0005, { acronym: 'SLCONS' })) })).toMatchObject({
                class: 'needs-review',
                review: ['structure'],
            });
            expect(depthOf({ PONTON: fc(across('PONTON')) })).toMatchObject({
                class: 'needs-review',
                review: ['structure'],
            });
            // A structure well clear of the line is not on it.
            expect(
                depthOf({
                    BRIDGE: fc(
                        lineF(
                            [
                                [0.01, 0.002],
                                [0.01, 0.004],
                            ],
                            { acronym: 'BRIDGE' },
                        ),
                    ),
                }).class,
            ).toBe('clear');
        });

        // Owner decisions 3 and 4 (2026-09-30): a lead is clear only if its
        // charted depth less the survey's vertical error (S-57 CATZOC: A1
        // 0.5 m + 1%, A2 and B 1.0 m + 2%, C 2.0 m + 5% of the depth) is still
        // draft + 0.5 m; D and U are never clear; a stretch no graded zone
        // covers is 'survey not graded'. The Phase 1 blanket "C is review"
        // is gone. Draft 2 m here: 2.5 m needed.
        const zone = (catzoc: number | undefined, extra: Record<string, unknown> = {}, x0 = -0.02, x1 = 0.05) =>
            box(x0, -0.01, x1, 0.01, {
                acronym: 'M_QUAL',
                ...(catzoc === undefined ? {} : { CATZOC: catzoc }),
                ...extra,
            });
        const at = (depthM: number, ...zones: Feature[]) =>
            depthOf({ DEPARE: fc(deep(-0.02, 0.05, depthM)), M_QUAL: fc(...zones) });

        it('the vertical error bounds: A1 0.5 m + 1%, A2 and B 1.0 m + 2%, C 2.0 m + 5%, none for D and U', () => {
            expect(catzocVerticalErrorM(1, 10)).toBeCloseTo(0.6, 9);
            expect(catzocVerticalErrorM(2, 10)).toBeCloseTo(1.2, 9);
            expect(catzocVerticalErrorM(3, 10)).toBeCloseTo(1.2, 9);
            expect(catzocVerticalErrorM(4, 10)).toBeCloseTo(2.5, 9);
            expect(catzocVerticalErrorM(5, 10)).toBeNull();
            expect(catzocVerticalErrorM(6, 10)).toBeNull();
        });

        it.each([
            // [CATZOC, just short of the margin, just clear of it]
            [1, 3.0, 3.1], // 3.0 − 0.53 = 2.47 < 2.5; 3.1 − 0.531 = 2.569
            [2, 3.5, 3.6], // 3.5 − 1.07 = 2.43; 3.6 − 1.072 = 2.528
            [3, 3.5, 3.6],
            [4, 4.7, 4.8], // 4.7 − 2.235 = 2.465; 4.8 − 2.24 = 2.56
        ])(
            'CATZOC %i: charted deep enough but inside the error is needs review; past it, clear',
            (catzoc, short, clear) => {
                expect(at(short, zone(catzoc))).toMatchObject({ class: 'needs-review', review: ['survey-margin'] });
                expect(at(clear, zone(catzoc))).toMatchObject({ class: 'clear', review: [] });
            },
        );

        it('a C zone with the margin to spare is clear (no longer blanket review)', () => {
            expect(at(10, zone(4))).toMatchObject({ class: 'clear', review: [] });
        });

        it('D and U are never clear, however deep', () => {
            for (const z of [5, 6])
                expect(at(30, zone(z)), `CATZOC ${z}`).toMatchObject({ class: 'needs-review', review: ['survey'] });
        });

        it('no graded survey is never clear: no M_QUAL, a zone without CATZOC, or a stretch no zone covers', () => {
            // No M_QUAL at all.
            expect(depthOf({ M_QUAL: fc() })).toMatchObject({ class: 'needs-review', review: ['survey-ungraded'] });
            expect(depthOf({ M_QUAL: undefined })).toMatchObject({
                class: 'needs-review',
                review: ['survey-ungraded'],
            });
            // The finest survey's zone carries no CATZOC: it grades nothing,
            // and a coarser zone's A1 does not speak for it.
            expect(at(10, zone(1, { _scaleRank: 100 }), zone(undefined, { _scaleRank: 200 }))).toMatchObject({
                class: 'needs-review',
                review: ['survey-ungraded'],
            });
            // An A1 zone over only the first half of the line.
            expect(at(10, zone(1, {}, -0.02, 0.01))).toMatchObject({
                class: 'needs-review',
                review: ['survey-ungraded'],
            });
            const span = compileLeadGraph(
                { ...base, DEPARE: fc(deep(-0.02, 0.05, 10)), M_QUAL: fc(zone(1, {}, -0.02, 0.01)) },
                2,
            ).spans[0];
            expect(span.review.survey.map((x) => x.catzoc)).toEqual([1, null]);
            expect(span.review.survey[1].lengthM).toBeGreaterThan(990);
        });

        it('a review that carries no survey facts at all is not graded, never clear', () => {
            // Every review the compiler builds carries `survey`. One that does
            // not (built before decisions 3 and 4, or malformed) cannot show
            // the survey is good enough for the draft, and unknown is never
            // clear (decision 4).
            const span = compileLeadGraph({ ...base, M_QUAL: fc(zone(1)) }, 2).spans[0];
            expect(leadClass(span, 2)).toEqual({ class: 'clear', review: [] });
            const noSurvey: Partial<LeadSpan['review']> = { ...span.review };
            delete noSurvey.survey;
            expect(leadClass({ ...span, review: noSurvey as LeadSpan['review'] }, 2)).toEqual({
                class: 'needs-review',
                review: ['survey-ungraded'],
            });
        });

        it('the finest survey owns each stretch; the worst grade within a rank', () => {
            // A harbour cell's A1 zone over an overview's U zone: A1 owns it.
            expect(at(10, zone(6, { _scaleRank: 100 }), zone(1, { _scaleRank: 200 })).class).toBe('clear');
            expect(at(10, zone(1, { _scaleRank: 100 }), zone(5, { _scaleRank: 200 }))).toMatchObject({
                class: 'needs-review',
                review: ['survey'],
            });
            // Two zones at one rank: the worse grade (C) and its error apply.
            expect(at(4.7, zone(1, { _scaleRank: 200 }), zone(4, { _scaleRank: 200 }))).toMatchObject({
                class: 'needs-review',
                review: ['survey-margin'],
            });
        });

        // Round-3 review (2026-09-30): the lead review ranked the ZONES alone,
        // so where a finer cell charts the water but carries no zone on it, a
        // coarser cell's A1 graded the lead — clear — while the route drew the
        // same water amber 'ungraded'. Zones, bands and land now rank together
        // (leadReview surveyGradeAt, the route's rule): no grade is borrowed.
        it('a finer band with no zone on it is not graded by a coarser zone (no borrowing)', () => {
            const fine = deep(-0.02, 0.05, 10, { _scaleRank: 200 });
            expect(depthOf({ DEPARE: fc(fine), M_QUAL: fc(zone(1, { _scaleRank: 100 })) })).toMatchObject({
                class: 'needs-review',
                review: ['survey-ungraded'],
            });
            // With the finer cell's own zone, its grade applies.
            expect(
                depthOf({
                    DEPARE: fc(fine),
                    M_QUAL: fc(zone(1, { _scaleRank: 100 }), zone(1, { _scaleRank: 200 })),
                }),
            ).toMatchObject({ class: 'clear', review: [] });
        });

        it('each piece is read against its own depth: a shallow piece no longer hides a deeper piece’s margin', () => {
            // One C zone over 2 m (needs tide: 2.5 m needed) and 4.7 m (4.7 −
            // 2.235 = 2.465 < 2.5: inside the error). One minimum per grade
            // read only the 2 m, a depth matter, and said nothing of the 4.7 m.
            const r = depthOf({
                DEPARE: fc(deep(-0.02, 0.01, 2), deep(0.01, 0.05, 4.7)),
                M_QUAL: fc(zone(4)),
            });
            expect(r).toMatchObject({ class: 'needs-tide' });
            expect(r.review).toContain('survey-margin');
        });

        it('each stretch is read against its own depth and grade', () => {
            // A1 over the 3.1 m half (clear by 0.069 m), C over the 20 m half
            // (clear by 14.5 m): clear. Graded the other way round, the C
            // stretch's 3.1 m is 2.9 m short of trusted: review.
            const halves = (west: number, east: number) =>
                depthOf({
                    DEPARE: fc(deep(-0.02, 0.01, 3.1), deep(0.01, 0.05, 20)),
                    M_QUAL: fc(zone(west, {}, -0.02, 0.01), zone(east, {}, 0.01, 0.05)),
                });
            expect(halves(1, 4)).toMatchObject({ class: 'clear', review: [] });
            expect(halves(4, 1)).toMatchObject({ class: 'needs-review', review: ['survey-margin'] });
        });

        it('the line label says which survey rule it is, in plain words', () => {
            const labelOf = (extra: Partial<LeadCompilerLayers>) =>
                leadGraphOverlayGeoJSON(compileLeadGraph({ ...base, ...extra }, 2)).features[0].properties.label;
            // No graded zone anywhere under it (decision 4).
            expect(labelOf({ M_QUAL: fc() })).toBe('Lead · survey not graded');
            // CATZOC D or U: no error bound to trust (decision 3).
            expect(labelOf({ M_QUAL: fc(zone(5)) })).toBe('Lead · poor or unassessed survey');
            // 4.7 m charted in a C zone is 2.465 m trusted, short of 2.5 m.
            expect(labelOf({ DEPARE: fc(deep(-0.02, 0.05, 4.7)), M_QUAL: fc(zone(4)) })).toBe(
                'Lead · survey too rough for this depth',
            );
            expect(labelOf({ M_QUAL: fc(zone(4)) })).toBe('Lead');
        });

        it('a shallow track stays needs tide, with the reasons listed', () => {
            const shallow: LeadCompilerLayers = { ...base, DEPARE: fc(deep(-0.02, 0.05, 1)) };
            expect(depthOf({ OBSTRN: fc(pt(0.01, dLat(30), { acronym: 'OBSTRN' })) }, shallow)).toMatchObject({
                class: 'needs-tide',
                review: ['hazard'],
            });
        });
    });

    // Phase 1 review (medium): with no draft entered the overlay classed
    // leads against the 2.5 m fallback (or onboarding's length × 0.16 guess)
    // and inked them clear. Against a guessed keel nothing is clear.
    it('with the draft not set, nothing is clear and every charted lead says so', () => {
        const layers: LeadCompilerLayers = {
            ...EXTRACTED,
            DEPARE: fc(deep(-0.02, 0.01, 10), deep(0.01, 0.05, 1)),
            RECTRC: fc(
                track(
                    [
                        [0, 0],
                        [0.009, 0],
                    ],
                    1,
                ),
                track(
                    [
                        [0.011, 0],
                        [0.03, 0],
                    ],
                    2,
                ),
            ),
        };
        const measured = compileLeadGraph(layers, 2.5);
        expect(measured.edges.find((e) => e.rcids.includes(1))!.depth.class).toBe('clear');
        const guessed = compileLeadGraph(layers, 2.5, {}, LEAD_UKC_M, { draftAssumed: true });
        expect(guessed.edges.some((e) => e.depth.class === 'clear')).toBe(false);
        expect(guessed.edges.find((e) => e.rcids.includes(1))!.depth).toMatchObject({
            class: 'needs-review',
            review: ['draft-not-set'],
        });
        expect(guessed.edges.find((e) => e.rcids.includes(2))!.depth).toMatchObject({
            class: 'needs-tide',
            review: ['draft-not-set'],
        });
        const labels = leadGraphOverlayGeoJSON(guessed).features.map((f) => f.properties.label);
        expect(labels.sort()).toEqual(['Lead · draft not set', 'Lead · needs tide · draft not set']);
    });

    // Phase 1 review (low + integrity medium): a MultiLineString lead gave
    // every part the same span id (numbering restarted at :0 per part), so
    // edge ids and reverseId collided and the overlay drew only the first
    // part. OSM lines without an id collided the same way.
    it('every part of a multi-part lead is its own span, with unique ids, and every part is drawn', () => {
        const twoPart: Feature = {
            type: 'Feature',
            properties: { acronym: 'RECTRC', rcid: 7, CATTRK: 1, TRAFIC: 4 },
            geometry: {
                type: 'MultiLineString',
                coordinates: [
                    [
                        [W + 0.001, S],
                        [W + 0.01, S],
                    ],
                    [
                        [W + 0.02, S + 0.005],
                        [W + 0.03, S + 0.005],
                    ],
                ],
            },
        };
        const g = compileLeadGraph({ DEPARE: fc(deep(-0.02, 0.05)), RECTRC: fc(twoPart) }, 2);
        expect(g.spans).toHaveLength(2);
        expect(new Set(g.spans.map((s) => s.id)).size).toBe(2);
        expect(g.edges).toHaveLength(4);
        expect(new Set(g.edges.map((e) => e.id)).size).toBe(4);
        for (const e of g.edges) expect(g.edges.find((x) => x.id === e.reverseId)?.spanId).toBe(e.spanId);
        expect(leadGraphOverlayGeoJSON(g).features).toHaveLength(2);

        const osmNoId = (y: number) =>
            lineF(
                [
                    [0, y],
                    [0.02, y],
                ],
                { 'seamark:type': 'navigation_line', 'seamark:navigation_line:category': 'leading' },
            );
        const o = compileLeadGraph({ DEPARE: fc(deep(-0.02, 0.05)) }, 2, {
            osmNavLines: [osmNoId(0.003), osmNoId(-0.003)],
        });
        expect(o.spans).toHaveLength(2);
        expect(new Set(o.spans.map((s) => s.id)).size).toBe(2);
        expect(leadGraphOverlayGeoJSON(o).features).toHaveLength(2);
    });
});

// ── Totals (Phase 1 review: the reported fixture numbers were never locked) ──

describe('lead compiler — fixture totals, pinned', () => {
    const summary = (g: LeadGraph) => {
        const tally = (keys: string[]) =>
            keys.reduce<Record<string, number>>((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {});
        return {
            spans: g.spans.length,
            edges: g.edges.length,
            nodes: g.nodes.length,
            networks: g.networks.length,
            dropped: tally(g.dropped.map((d) => d.reason)),
            kinds: tally(g.spans.map((s) => s.kind)),
            classes: tally(forward(g).map((e) => `${e.kind}:${e.depth.class}`)),
        };
    };

    // A change here is a behaviour change: re-pin it deliberately, with the
    // reason, never to make a run go green.
    //
    // Re-pinned 2026-09-30 (owner decisions 3 and 4): CATZOC C is read against
    // its error bound instead of blanket review, so RECTRC 2374 (5 m, C) and
    // NAVLNE 2387:0 (10 m, C and A1) are clear at 1.9 m; NAVLNE 2373 keeps
    // 'hazard'. clippedLandM is unchanged: on these two cells no lead runs
    // over land paint that a finer band beats (decision 1).
    it('Newport (ENB5 + RCS5, merged) at a 1.9 m draft', () => {
        const g = compileLeadGraph(newport, 1.9);
        expect(summary(g)).toEqual({
            spans: 65,
            edges: 130,
            nodes: 84,
            networks: 19,
            dropped: { 'coincides-with-recommended-track': 1, duplicate: 6 },
            kinds: { 'recommended-track': 18, 'leading-line': 21, channel: 26 },
            classes: {
                'recommended-track:clear': 16,
                'recommended-track:needs-tide': 2,
                'leading-line:clear': 1,
                'leading-line:needs-review': 2,
                'leading-line:needs-tide': 16,
                'leading-line:unknown': 2,
                'channel:clear': 10,
                'channel:needs-tide': 16,
            },
        });
        expect(Math.round(g.clippedLandM)).toBe(4_745);
    });

    // Re-pinned 2026-09-30 (owner decision 1). The capture carries no ranks,
    // so no band under land paint can be shown finer: all of it is land
    // (fail safe). Phase 1 let any charted water beat unranked land, so 47
    // spans that lay over the overview cell's land paint are gone (dropped
    // on-land 15 → 51, clipped 28,324 → 66,901 m), and the corridor is pinned
    // RANKED below — the shape production merges. Decision 4: no M_QUAL in
    // the capture, so nothing is graded; every deep lead left would be
    // needs-review, and none is (the unranked bands' shallowest-wins depth).
    it('Moreton corridor (four cells, as the fixture merged them: unranked) at a 1.9 m draft', () => {
        const g = compileLeadGraph(moreton, 1.9);
        expect(summary(g)).toEqual({
            spans: 53,
            edges: 106,
            nodes: 78,
            networks: 25,
            dropped: { 'on-land': 51, duplicate: 16, 'coincides-with-recommended-track': 1 },
            kinds: { 'recommended-track': 27, 'leading-line': 5, channel: 21 },
            classes: {
                'recommended-track:needs-tide': 27,
                'leading-line:needs-tide': 5,
                'channel:needs-tide': 21,
            },
        });
        expect(Math.round(g.clippedLandM)).toBe(66_901);
    });

    // New 2026-09-30: the same corridor ranked as the router's merge ranks it
    // (tests/helpers/corridorCellRanks). The finer ENB5 / detail-cell bands
    // beat the overviews' land paint wherever they never dry, so fewer leads
    // are cut than in Phase 1's unranked pin (on-land 15 → 5, clipped
    // 28,324 → 18,210 m) — but every span that runs over such paint is
    // 'needs tide' ('land-paint'), never clear. The capture has no M_QUAL:
    // nothing is graded (decision 4), so no span is clear either way.
    //
    // RE-PIN (D12 fix-up, 2026-10-03; owner decision 12, Shane: "Trust the
    // detailed chart"; measured in its own process): the same 110 spans and
    // 18,210 m clipped (the first D12 build, which let drying detailed bands
    // count, had 115 spans and 8,121 m of leads over drying ground under the
    // overview's land — reverted). Where only the overview cells' land paint
    // lies over a detailed chart's never-drying band, a span is no longer in
    // dispute: 'land-paint' 71 → 18 edges. Ten deep spans that were 'needs
    // tide' only for that paint (least 5–14 m: RECTRC 2386, 2658, 2659,
    // 2921, 2946 and five buoyed-channel spans) are 'needs review' — survey
    // ungraded (decision 4), never clear; the rest stay 'needs tide' by their
    // own charted depth. The 18 left in dispute are a detailed chart's land
    // over a finer band (decision 1), all still 'needs tide'.
    it('Moreton corridor, ranked as production merges it, at a 1.9 m draft', () => {
        const g = compileLeadGraph(moretonRanked, 1.9);
        expect(summary(g)).toEqual({
            spans: 110,
            edges: 220,
            nodes: 146,
            networks: 36,
            dropped: { duplicate: 16, 'coincides-with-recommended-track': 1, 'on-land': 5 },
            kinds: { 'recommended-track': 39, 'leading-line': 34, channel: 37 },
            classes: {
                'recommended-track:needs-review': 20,
                'recommended-track:needs-tide': 19,
                'leading-line:needs-review': 2,
                'leading-line:needs-tide': 32,
                'channel:needs-review': 10,
                'channel:needs-tide': 27,
            },
        });
        expect(Math.round(g.clippedLandM)).toBe(18_210);
        const landPaint = forward(g).filter((e) => e.depth.review.includes('land-paint'));
        expect(landPaint.length).toBe(18);
        for (const e of landPaint) expect(e.depth.class).toBe('needs-tide');
    });
});

// ── Cache + performance + overlay ──────────────────────────────────

describe('lead compiler — one compile per cell set, measured', () => {
    beforeEach(() => clearLeadGraphCache());

    it('compiles a cell set once and re-classifies per draft without recompiling', () => {
        let loads = 0;
        const layers = () => {
            loads++;
            return newport;
        };
        const a = cachedLeadGraph(NEWPORT_IDS, 1.9, layers);
        const b = cachedLeadGraph([...NEWPORT_IDS].reverse(), 1.9, layers);
        expect(b).toBe(a);
        const c = cachedLeadGraph(NEWPORT_IDS, 3.5, layers);
        expect(c).not.toBe(a);
        expect(c.spans).toBe(a.spans);
        expect(loads).toBe(1);
    });

    it('compiles the fixtures quickly (measured)', () => {
        const n = compileLeadSpans(newport);
        const m = compileLeadSpans(moreton);
        // Reported, not tuned: generous bounds so a slow CI box does not flake.
        console.info(
            `[leadCompiler] newport: ${n.spans.length} spans in ${n.compileMs} ms; moreton: ${m.spans.length} spans in ${m.compileMs} ms`,
        );
        expect(n.compileMs).toBeLessThan(5_000);
        expect(m.compileMs).toBeLessThan(10_000);
    });

    it('draws one overlay line per span with its ink, depth class and label', () => {
        const g = compileLeadGraph(newport, 1.9);
        const fcOut = leadGraphOverlayGeoJSON(g);
        expect(fcOut.features).toHaveLength(g.spans.length);
        const byId = new Map(fcOut.features.map((f) => [f.properties.spanId, f.properties]));
        const t2380 = g.spans.find((s) => s.rcids.includes(2380))!;
        expect(byId.get(t2380.id)).toMatchObject({ ink: 'lead', depthClass: 'clear', label: 'Lead' });
        const t407 = g.spans.find((s) => s.rcids.includes(407))!;
        expect(byId.get(t407.id)).toMatchObject({ ink: 'lead', depthClass: 'needs-tide', label: 'Lead · needs tide' });
        expect(fcOut.features.some((f) => f.properties.ink === 'channel')).toBe(true);
        expect(leadGraphOverlayGeoJSON(null).features).toEqual([]);
    });
});

// ── Structures the chart data cannot show ─────────────────────────
//
// Phase 1 review (medium, 2026-09-29): neither cell pipeline emits BRIDGE or
// PONTON (both sit in the SENC extractor's "Deferred" list and are missing
// from the Pi's ENC_LAYERS), nor overhead cables or pipes (CBLOHD / PIPOHD).
// The real Newport blobs carry none of them, so a lead under a fixed bridge
// could never gain the 'bridge' reason and was inked solid "clear — nothing
// charted on the line" — against the owner's rule that a bridge of unknown
// clearance blocks. The unit tests above only passed because they inject
// synthetic BRIDGE / PONTON features. Now: where the data under a lead does
// not CARRY those layers (an empty collection is the "extracted, none
// charted" contract a re-extracted cell meets), nothing is clear.
describe('structures the chart data cannot show: never clear', () => {
    const STRUCTURE_KEYS = ['BRIDGE', 'PONTON', 'CBLOHD', 'PIPOHD', 'CONVYR'] as const;

    it('the real Newport blobs carry none of the structure layers (fixture pin)', () => {
        for (const id of NEWPORT_IDS) {
            for (const k of STRUCTURE_KEYS) expect(encCell(id).layers[k], `${id} ${k}`).toBeUndefined();
        }
    });

    it('on the real blobs nothing is clear, and every lead says why', () => {
        const g = compileLeadGraph(mergeLeadCells(newportCells), 1.9);
        expect(g.edges.length).toBeGreaterThan(20);
        expect(g.edges.some((e) => e.depth.class === 'clear')).toBe(false);
        for (const e of g.edges) expect(e.depth.review, e.id).toContain('structures-unknown');
        // RECTRC 2380 — 9.1 m, nothing charted near it — is the one that would be clear.
        const t2380 = forward(g).find((e) => e.kind === 'recommended-track' && e.rcids.includes(2380))!;
        expect(t2380.depth).toMatchObject({ class: 'needs-review', minDepthM: 9.1, review: ['structures-unknown'] });
        const label = leadGraphOverlayGeoJSON(g).features.find((f) => f.properties.spanId === t2380.spanId)!.properties
            .label;
        expect(label).toBe('Lead · bridges not in chart data');
    });

    it('the same cells re-extracted with the layers (empty: none charted) can be clear', () => {
        const g = compileLeadGraph(mergeLeadCells(newportExtracted), 1.9);
        const t2380 = forward(g).find((e) => e.kind === 'recommended-track' && e.rcids.includes(2380))!;
        expect(t2380.depth).toMatchObject({ class: 'clear', review: [] });
    });

    it('one cell without them leaves every lead over its extent unreviewed', () => {
        const extracted = Object.fromEntries(STRUCTURE_KEYS.map((k) => [k, { features: [] }]));
        const cell = (id: string, x0: number, withStructures: boolean, rcid: number) => ({
            id,
            bbox: [W + x0, S - 0.01, W + x0 + 0.02, S + 0.01] as [number, number, number, number],
            layers: {
                DEPARE: fc(deep(x0, x0 + 0.02)),
                ...GRADED,
                RECTRC: fc(
                    track(
                        [
                            [x0 + 0.002, 0],
                            [x0 + 0.018, 0],
                        ],
                        rcid,
                    ),
                ),
                ...(withStructures ? extracted : {}),
            },
        });
        const g = compileLeadGraph(mergeLeadCells([cell('A', 0, true, 1), cell('B', 0.03, false, 2)]), 2);
        expect(g.edges.find((e) => e.rcids.includes(1))!.depth).toMatchObject({ class: 'clear', review: [] });
        expect(g.edges.find((e) => e.rcids.includes(2))!.depth).toMatchObject({
            class: 'needs-review',
            review: ['structures-unknown'],
        });
    });

    it('a layer set with no structure collections at all is unreviewed; a shallow lead lists it too', () => {
        const bare = {
            ...GRADED,
            DEPARE: fc(deep(-0.02, 0.05)),
            RECTRC: fc(
                track(
                    [
                        [0, 0],
                        [0.02, 0],
                    ],
                    1,
                ),
            ),
        };
        expect(compileLeadGraph(bare, 2).edges[0].depth).toMatchObject({
            class: 'needs-review',
            review: ['structures-unknown'],
        });
        expect(compileLeadGraph({ ...bare, DEPARE: fc(deep(-0.02, 0.05, 1)) }, 2).edges[0].depth).toMatchObject({
            class: 'needs-tide',
            review: ['structures-unknown'],
        });
    });

    it('an overhead cable across the line is read once the data carries it', () => {
        const extracted = Object.fromEntries(STRUCTURE_KEYS.map((k) => [k, fc()]));
        const cable = lineF(
            [
                [0.01, -0.001],
                [0.01, 0.001],
            ],
            { acronym: 'CBLOHD', rcid: 5, VERCLR: 18 },
        );
        const g = compileLeadGraph(
            {
                ...extracted,
                ...GRADED,
                DEPARE: fc(deep(-0.02, 0.05)),
                RECTRC: fc(
                    track(
                        [
                            [0, 0],
                            [0.02, 0],
                        ],
                        1,
                    ),
                ),
                CBLOHD: fc(cable),
            },
            2,
        );
        // No air draft given: an 18 m cable cannot be checked, so it blocks.
        expect(g.edges[0].depth).toMatchObject({
            class: 'blocked',
            review: ['overhead-clearance', 'air-draft-not-set'],
        });
        expect(g.spans[0].review.structures[0]).toMatchObject({
            layer: 'CBLOHD',
            rcid: 5,
            verclrM: 18,
            clearanceM: 18,
            opening: false,
        });
    });
});

// ── Bridges and overhead clearance against the air draft (Part B) ────
//
// Owner decisions (2026-09-29/30): a bridge / overhead cable / overhead pipe /
// overhead conveyor whose charted clearance is below air draft + 1 m, whose
// clearance is not charted, or on a boat with no air draft set, BLOCKS. The
// overlay shows a lead under one as 'blocked' (round 2, 2026-09-30 — it was
// amber 'needs-review'): red, dashed, never saveable, the label naming the
// structure and its clearance, with a 'bridge clearance' reason. One that
// clears the mast still keeps the lead amber ('bridge on the line (clears
// your mast)'): a bridge narrows the channel. Serene Summer: 18 m air draft.
describe('bridges and overhead lines against the air draft', () => {
    const AIR = 18;
    const deepTrack: LeadCompilerLayers = {
        ...EXTRACTED,
        DEPARE: fc(deep(-0.02, 0.05)),
        RECTRC: fc(
            track(
                [
                    [0, 0],
                    [0.02, 0],
                ],
                1,
            ),
        ),
    };
    const across = (layer: 'BRIDGE' | 'CBLOHD' | 'PIPOHD' | 'CONVYR', props: Record<string, unknown>) =>
        lineF(
            [
                [0.01, -0.001],
                [0.01, 0.001],
            ],
            { acronym: layer, rcid: 3, ...props },
        );
    const classed = (extra: Partial<LeadCompilerLayers>, airDraftM: number | null = AIR, layers = deepTrack) =>
        compileLeadGraph({ ...layers, ...extra }, 2, {}, LEAD_UKC_M, { airDraftM }).edges.find((e) =>
            e.rcids.includes(1),
        )!.depth;

    it('a 16 m bridge under an 18 m mast: BLOCKED, never saveable, the label naming it and its clearance', () => {
        expect(classed({ BRIDGE: fc(across('BRIDGE', { VERCLR: 16, OBJNAM: 'Hornibrook' })) })).toMatchObject({
            class: 'blocked',
            review: ['bridge-clearance'],
            blockedBy: [{ layer: 'BRIDGE', name: 'Hornibrook', clearanceM: 16, block: 'too-low' }],
        });
        const g = compileLeadGraph(
            { ...deepTrack, BRIDGE: fc(across('BRIDGE', { VERCLR: 16, OBJNAM: 'Hornibrook' })) },
            2,
            {},
            LEAD_UKC_M,
            { airDraftM: AIR },
        );
        const props = leadGraphOverlayGeoJSON(g).features[0].properties;
        expect(props.depthClass).toBe('blocked');
        expect(props.saveable).toBe(false);
        expect(props.label).toBe('Lead · blocked · bridge "Hornibrook" 16 m clearance, too low for your mast');
        expect(leadClassSaveable('blocked')).toBe(false);
    });

    it('a 25 m bridge clears the mast: still amber, "clears your mast", and saveable', () => {
        expect(classed({ BRIDGE: fc(across('BRIDGE', { VERCLR: 25 })) })).toMatchObject({
            class: 'needs-review',
            review: ['bridge'],
        });
        const g = compileLeadGraph({ ...deepTrack, BRIDGE: fc(across('BRIDGE', { VERCLR: 25 })) }, 2, {}, LEAD_UKC_M, {
            airDraftM: AIR,
        });
        const props = leadGraphOverlayGeoJSON(g).features[0].properties;
        expect(props.label).toMatch(/clears your mast/);
        expect(props.saveable).toBe(true);
    });

    it('a charted-shallow lead stays saveable: amber "needs tide" (owner decision 6)', () => {
        expect(leadClassSaveable('needs-tide')).toBe(true);
        const g = compileLeadGraph({ ...deepTrack, DEPARE: fc(deep(-0.02, 0.05, 1)) }, 2, {}, LEAD_UKC_M, {
            airDraftM: AIR,
        });
        expect(leadGraphOverlayGeoJSON(g).features[0].properties).toMatchObject({
            depthClass: 'needs-tide',
            saveable: true,
        });
    });

    it('no charted clearance, or no air draft set, blocks the lead', () => {
        expect(classed({ BRIDGE: fc(across('BRIDGE', {})) })).toMatchObject({
            class: 'blocked',
            review: ['bridge-clearance'],
            blockedBy: [{ layer: 'BRIDGE', clearanceM: null, block: 'clearance-unknown' }],
        });
        expect(classed({ BRIDGE: fc(across('BRIDGE', { VERCLR: 40 })) }, null)).toMatchObject({
            class: 'blocked',
            blockedBy: [{ block: 'air-draft-unset', clearanceM: 40 }],
        });
        expect(classed({ BRIDGE: fc(across('BRIDGE', { VERCLR: 40 })) }, null).review).toEqual([
            'bridge-clearance',
            'air-draft-not-set',
        ]);
        const unset = compileLeadGraph(
            { ...deepTrack, BRIDGE: fc(across('BRIDGE', { VERCLR: 40 })) },
            2,
            {},
            LEAD_UKC_M,
            { airDraftM: null },
        );
        expect(leadGraphOverlayGeoJSON(unset).features[0].properties.label).toBe(
            'Lead · blocked · bridge 40 m clearance, air draft not set',
        );
    });

    it('an opening bridge that does not clear closed, and low overhead lines, are clearance reasons', () => {
        expect(classed({ BRIDGE: fc(across('BRIDGE', { CATBRG: 4, VERCCL: 5, VERCOP: 40 })) }).review).toEqual([
            'bridge-clearance',
        ]);
        expect(classed({ CBLOHD: fc(across('CBLOHD', { VERCSA: 12 })) }).review).toEqual(['overhead-clearance']);
        expect(classed({ PIPOHD: fc(across('PIPOHD', {})) }).review).toEqual(['overhead-clearance']);
        expect(classed({ CBLOHD: fc(across('CBLOHD', { VERCSA: 30 })) }).review).toEqual(['overhead']);
        for (const extra of [
            { BRIDGE: fc(across('BRIDGE', { CATBRG: 4, VERCCL: 5, VERCOP: 40 })) },
            { CBLOHD: fc(across('CBLOHD', { VERCSA: 12 })) },
            { PIPOHD: fc(across('PIPOHD', {})) },
        ]) {
            expect(classed(extra).class).toBe('blocked');
        }
        expect(classed({ CBLOHD: fc(across('CBLOHD', { VERCSA: 30 })) }).class).toBe('needs-review');
    });

    it('an overhead conveyor (CONVYR) is read like any overhead line (round 2, 2026-09-30)', () => {
        expect(classed({ CONVYR: fc(across('CONVYR', { VERCLR: 12, OBJNAM: 'Coal loader' })) })).toMatchObject({
            class: 'blocked',
            review: ['overhead-clearance'],
            blockedBy: [{ layer: 'CONVYR', name: 'Coal loader', clearanceM: 12, block: 'too-low' }],
        });
        const g = compileLeadGraph(
            { ...deepTrack, CONVYR: fc(across('CONVYR', { VERCLR: 12, OBJNAM: 'Coal loader' })) },
            2,
            {},
            LEAD_UKC_M,
            { airDraftM: AIR },
        );
        expect(leadGraphOverlayGeoJSON(g).features[0].properties.label).toBe(
            'Lead · blocked · overhead conveyor "Coal loader" 12 m clearance, too low for your mast',
        );
        expect(classed({ CONVYR: fc(across('CONVYR', { VERCLR: 30 })) })).toMatchObject({
            class: 'needs-review',
            review: ['overhead'],
        });
    });

    it('a shallow lead under a low bridge is blocked too: the mast cannot pass, whatever the depth', () => {
        expect(
            classed({ BRIDGE: fc(across('BRIDGE', { VERCLR: 16 })) }, AIR, {
                ...deepTrack,
                DEPARE: fc(deep(-0.02, 0.05, 1)),
            }),
        ).toMatchObject({ class: 'blocked', review: ['bridge-clearance'] });
    });

    it('the cache classes the same cells again for a different air draft', () => {
        clearLeadGraphCache();
        const layers = { ...deepTrack, BRIDGE: fc(across('BRIDGE', { VERCLR: 25 })) };
        const tall = cachedLeadGraph(['A'], 2, () => layers, {}, LEAD_UKC_M, { airDraftM: 30 });
        const short = cachedLeadGraph(['A'], 2, () => layers, {}, LEAD_UKC_M, { airDraftM: AIR });
        expect(tall.edges[0].depth.review).toEqual(['bridge-clearance']);
        expect(short.edges[0].depth.review).toEqual(['bridge']);
    });

    it('on the real Newport cells re-extracted WITH a low bridge across RECTRC 2380, that lead says bridge clearance', () => {
        // The real blobs carry no structure layers (pinned above: every lead is
        // 'structures-unknown'). Re-extracted, they carry the layers; here one
        // of them also charts a 16 m bridge straight across RECTRC 2380.
        // Half-way along the compiled span, well clear of the network nodes
        // at its ends (where 2382 and the leading lines 2379 / 2381 join).
        const before = forward(compileLeadGraph(newport, 1.9, {}, LEAD_UKC_M, { airDraftM: AIR })).find(
            (x) => x.kind === 'recommended-track' && x.rcids.includes(2380),
        )!;
        const [a, b] = [before.coordinates[0], before.coordinates[before.coordinates.length - 1]];
        const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const bridge: Feature = {
            type: 'Feature',
            properties: { acronym: 'BRIDGE', rcid: 99001, VERCLR: 16, OBJNAM: 'Synthetic Bridge' },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [mid[0] - 0.0002, mid[1] - 0.0002],
                    [mid[0] + 0.0002, mid[1] + 0.0002],
                ],
            },
        };
        const cells = newportExtracted.map((c, i) =>
            i === 0 ? { ...c, layers: { ...c.layers, BRIDGE: { features: [bridge] } } } : c,
        );
        const g = compileLeadGraph(mergeLeadCells(cells), 1.9, {}, LEAD_UKC_M, { airDraftM: AIR });
        const e = forward(g).find((x) => x.kind === 'recommended-track' && x.rcids.includes(2380))!;
        expect(e.depth).toMatchObject({
            class: 'blocked',
            minDepthM: 9.1,
            review: ['bridge-clearance'],
            blockedBy: [{ layer: 'BRIDGE', name: 'Synthetic Bridge', clearanceM: 16, block: 'too-low' }],
        });
        // Nothing else in the view gained a clearance reason from it.
        expect(
            forward(g)
                .filter((x) => x.depth.review.includes('bridge-clearance'))
                .map((x) => x.spanId),
        ).toEqual([e.spanId]);
        // With a mast that clears it, the same lead is amber 'bridge on the line'.
        const tall = compileLeadGraph(mergeLeadCells(cells), 1.9, {}, LEAD_UKC_M, { airDraftM: 12 });
        const e2 = forward(tall).find((x) => x.spanId === e.spanId)!;
        expect(e2.depth).toMatchObject({ class: 'needs-review', review: ['bridge'] });
    });
});
