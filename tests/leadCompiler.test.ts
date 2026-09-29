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
    leadDepthClass,
    leadGraphOverlayGeoJSON,
    mergeLeadCells,
    type LeadCompilerLayers,
    type LeadEdge,
    type LeadGraph,
    type LeadSpan,
} from '../services/routing/leadCompiler';
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
const newportCells = NEWPORT_IDS.map((id) => {
    const c = encCell(id);
    return { id, bbox: extent(c.layers as AnyLayers), layers: c.layers };
});
/**
 * The same cells as if re-extracted with the structure layers (BRIDGE,
 * PONTON, CBLOHD, PIPOHD) carried empty — "extracted, none charted". The real
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
    },
}));
const newport: LeadCompilerLayers = mergeLeadCells(newportExtracted);
const newportRaw = (layer: string): Feature[] => NEWPORT_IDS.flatMap((id) => encCell(id).layers[layer]?.features ?? []);

const moretonFx = loadFixture('moreton-bay-tier2.corridor.json.gz');
const moreton = moretonFx.cells as unknown as LeadCompilerLayers;

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
        // 9.1 m and 5 m tracks: deep enough for both keels. 2380 is clear;
        // 2374 lies in a CATZOC C (4) survey zone, so under the Phase 1
        // review's clear contract it is 'needs-review' (survey), not clear —
        // deep enough by the chart, but the chart's survey says verify.
        for (const g of [g19, g35]) {
            expect(cls(g, 2380)).toMatchObject({ class: 'clear', minDepthM: 9.1, uncoveredM: 0, review: [] });
            expect(cls(g, 2374)).toMatchObject({ class: 'needs-review', minDepthM: 5, review: ['survey'] });
            expect(g.spans.find((s) => s.rcids.includes(2374))!.review.worstCatzoc).toBe(4);
            // A 2 m track and the 0 m Newport canal exit: charted, but needs tide.
            expect(cls(g, 2493)).toMatchObject({ class: 'needs-tide', minDepthM: 2 });
            expect(cls(g, 407)).toMatchObject({ class: 'needs-tide', minDepthM: 0 });
        }
        const counts = (g: LeadGraph) =>
            forward(g).reduce<Record<string, number>>((m, e) => {
                const k = `${e.kind}:${e.depth.class}`;
                m[k] = (m[k] ?? 0) + 1;
                return m;
            }, {});
        // 18 tracks: 15 clear, 1 deep but in a CATZOC C zone (2374), 2 needs tide.
        expect(counts(g19)).toMatchObject({
            'recommended-track:clear': 15,
            'recommended-track:needs-review': 1,
            'recommended-track:needs-tide': 2,
        });
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

    it('no clear edge passes an unknown or too-shallow charted hazard within 60 m, or lies in CATZOC C/D/U', () => {
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
        // The finest survey zone at a point (cell fineness from the merged ranks).
        const zones = (newport.M_QUAL?.features ?? []) as Feature[];
        const catzocAt = (lon: number, lat: number): number | null => {
            let bestRank = -Infinity;
            let worst: number | null = null;
            for (const z of zones) {
                const g = z.geometry as Polygon | MultiPolygon;
                if (!pointInGeometry(lon, lat, g)) continue;
                const rank = Number(z.properties?._scaleRank);
                const c = Number(z.properties?.CATZOC);
                if (rank > bestRank) {
                    bestRank = rank;
                    worst = c;
                } else if (rank === bestRank) worst = Math.max(worst ?? c, c);
            }
            return worst;
        };
        const clear = forward(g19).filter((e) => e.depth.class === 'clear');
        expect(clear.length).toBeGreaterThan(20);
        let poorSurveyDemoted = 0;
        for (const e of forward(g19)) {
            const c = e.coordinates;
            let poor = false;
            for (let i = 0; i < c.length - 1 && !poor; i++) {
                const n = Math.max(1, Math.ceil(haversineM(c[i][1], c[i][0], c[i + 1][1], c[i + 1][0]) / 10));
                for (let k = 0; k <= n && !poor; k++) {
                    const t = k / n;
                    const z = catzocAt(c[i][0] + (c[i + 1][0] - c[i][0]) * t, c[i][1] + (c[i + 1][1] - c[i][1]) * t);
                    if (z !== null && z >= 4) poor = true;
                }
            }
            if (poor) {
                expect(e.depth.class, e.id).not.toBe('clear');
                if (e.depth.review.includes('survey')) poorSurveyDemoted++;
            }
            if (e.depth.class !== 'clear') continue;
            for (const p of points) expect(distToLineM(p, e.coordinates), e.id).toBeGreaterThanOrEqual(58);
        }
        // Spans the chart surveys at CATZOC C/D really are demoted on this fixture.
        expect(poorSurveyDemoted).toBeGreaterThan(0);
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

    it('keeps a recommended track that a coarse overview paints as land but the finer chart charts as deep water', () => {
        // RECTRC 2380 sits under the overview cell's LNDARE and over ENB5's 9.1 m DEPARE.
        const s = spansOf(g, 2380);
        expect(s).toHaveLength(1);
        expect(s[0].sourceLandM).toBe(0);
        expect(s[0].lengthM).toBeGreaterThan(1_500);
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
/** The structure layers carried empty — "extracted, none charted". A layer set
 * without them is never clear (see the end of this file); tests of the other
 * rules carry them so 'clear' stays reachable. */
const EXTRACTED = { BRIDGE: fc(), PONTON: fc(), CBLOHD: fc(), PIPOHD: fc() };

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

    it('a drying band under the land paint is still land; charted water beats it', () => {
        const base = {
            LNDARE: fc(box(0.01, -0.01, 0.02, 0.01, { acronym: 'LNDARE' })),
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
        const drying = compileLeadGraph(
            { ...base, DEPARE: fc(box(0.01, -0.01, 0.02, 0.01, { acronym: 'DEPARE', DRVAL1: -1 })) },
            2,
        );
        expect(spansOf(drying, 7)[0].sourceLandM).toBeGreaterThan(990);
        const wet = compileLeadGraph(
            { ...base, DEPARE: fc(box(0.01, -0.01, 0.02, 0.01, { acronym: 'DEPARE', DRVAL1: 3 })) },
            2,
        );
        expect(spansOf(wet, 7)).toHaveLength(1);
        expect(spansOf(wet, 7)[0].sourceLandM).toBe(0);
        // Injected OSM water (no S-57 identity) is not chart evidence.
        const osm = compileLeadGraph(
            { ...base, DEPARE: fc(box(0.01, -0.01, 0.02, 0.01, { DRVAL1: 10, water: 'river' })) },
            2,
        );
        expect(spansOf(osm, 7)[0].sourceLandM).toBeGreaterThan(990);
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
        expect(e19.depth).toEqual({ minDepthM: 3, uncoveredM: 0, class: 'clear', review: [] });
        expect(compileLeadGraph(layers, 3.5).edges.find((e) => e.rcids.includes(1))!.depth.class).toBe('needs-tide');
        // Track 2 runs 1 km past the charted band: unknown at any draft.
        expect(at(1.9, 2).depth.uncoveredM).toBeGreaterThan(990);
        for (const d of [1.9, 3.5]) {
            expect(compileLeadGraph(layers, d).edges.find((e) => e.rcids.includes(2))!.depth.class).toBe('unknown');
        }
        expect(leadDepthClass({ minDepthM: null, uncoveredM: 0 }, 1)).toBe('unknown');
        expect(leadDepthClass({ minDepthM: 2.4, uncoveredM: 0 }, 1.9)).toBe('clear');
        expect(leadDepthClass({ minDepthM: 2.39, uncoveredM: 0 }, 1.9)).toBe('needs-tide');
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
            expect(depthOf({ BRIDGE: fc(across('BRIDGE')) })).toMatchObject({
                class: 'needs-review',
                review: ['bridge'],
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

        it('a CATZOC C, D or U survey under the line demotes it; the finest survey owns the zone', () => {
            const zone = (catzoc: number, extra: Record<string, unknown> = {}) =>
                box(-0.02, -0.01, 0.05, 0.01, { acronym: 'M_QUAL', CATZOC: catzoc, ...extra });
            for (const z of [4, 5, 6]) {
                expect(depthOf({ M_QUAL: fc(zone(z)) }), `CATZOC ${z}`).toMatchObject({
                    class: 'needs-review',
                    review: ['survey'],
                });
            }
            for (const z of [1, 2, 3]) expect(depthOf({ M_QUAL: fc(zone(z)) }).class, `CATZOC ${z}`).toBe('clear');
            // A harbour cell's A1 zone over an overview's U zone: A1 owns it.
            expect(depthOf({ M_QUAL: fc(zone(6, { _scaleRank: 100 }), zone(1, { _scaleRank: 200 })) }).class).toBe(
                'clear',
            );
            expect(depthOf({ M_QUAL: fc(zone(1, { _scaleRank: 100 }), zone(5, { _scaleRank: 200 })) }).class).toBe(
                'needs-review',
            );
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
                'recommended-track:clear': 15,
                'recommended-track:needs-review': 1,
                'recommended-track:needs-tide': 2,
                'leading-line:needs-review': 3,
                'leading-line:needs-tide': 16,
                'leading-line:unknown': 2,
                'channel:clear': 10,
                'channel:needs-tide': 16,
            },
        });
        expect(Math.round(g.clippedLandM)).toBe(4_745);
    });

    it('Moreton corridor (four cells, as the fixture merged them) at a 1.9 m draft', () => {
        const g = compileLeadGraph(moreton, 1.9);
        expect(summary(g)).toEqual({
            spans: 100,
            edges: 200,
            nodes: 135,
            networks: 35,
            dropped: { 'on-land': 15, duplicate: 16, 'coincides-with-recommended-track': 1 },
            kinds: { 'recommended-track': 38, 'leading-line': 30, channel: 32 },
            // The fixture's cells carry no bridge, pontoon or overhead-line
            // layers, so the 9 tracks deep enough at 1.9 m are needs-review
            // ('structures-unknown'), not clear (Phase 1 review, 2026-09-29).
            classes: {
                'recommended-track:needs-review': 9,
                'recommended-track:needs-tide': 29,
                'leading-line:needs-review': 1,
                'leading-line:needs-tide': 29,
                'channel:needs-tide': 32,
            },
        });
        expect(Math.round(g.clippedLandM)).toBe(28_324);
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
    const STRUCTURE_KEYS = ['BRIDGE', 'PONTON', 'CBLOHD', 'PIPOHD'] as const;

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
        expect(g.edges[0].depth).toMatchObject({ class: 'needs-review', review: ['overhead'] });
        expect(g.spans[0].review.structures[0]).toMatchObject({ layer: 'CBLOHD', rcid: 5, verclrM: 18 });
    });
});
