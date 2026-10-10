/**
 * Leads cut to their on-water spans ONCE at routeInshore entry
 * (withNavLineLeadsOnly), and in the tracer's context (inshore router Phase 2
 * carry-over, 2026-09-30).
 *
 * Phase 1 cut the land extension off a lead in the grid (navGrid Pass 5b, by
 * its own land verdict) and in the land audit (leadLandClip navLinesOnWater),
 * but the tier pipeline's lead snaps, the leading-line approach and the egress
 * splice, and the tracer's tap-snap and ridingLeadAt, still read the raw
 * lines: NAVLNE 2379 runs ~1.1 km over the Newport cells' LNDARE, and the
 * Moreton corridor's RECTRC 2655 lies wholly on land paint. Now every NAVLINE
 * lead and every RECTRC is cut once with the lead compiler's S-57 land rule
 * (owner decision 1 included); the grid alone keeps the pre-clip leads
 * (NAVLINE_GRID), because its own verdict also counts OSM water.
 *
 * Land is measured independently here: 5 m samples against the raw LNDARE
 * polygons with the engine's pointInGeometry.
 */
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from 'geojson';
import { beforeAll, describe, expect, it } from 'vitest';
import { geometryBbox, haversineM, pointInGeometry } from '../../services/engine/geometry';
import type { InshoreLayers } from '../../services/engine/types';
import { cellFinenessRank } from '../../services/enc/scaleShadow';
import { withNavLineLeadsOnly } from '../../services/inshoreRouterEngine';
import { navLineLeads } from '../../services/leadingLine';
import { tracerContextFromLayers } from '../../services/routeTracer';
import { CORRIDOR_CELL_SCALE, corridorCellRanks, withCorridorCellRanks } from '../helpers/corridorCellRanks';
import { loadFixture } from '../helpers/corridorFixture';
import { encCell } from '../helpers/encCells';
import { lazy, REAL_AU_CHART_FIXTURES_RETIRED } from '../helpers/retiredChartFixtures';

const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });

// ── The Newport cells, merged the router's way (ranked LNDARE/DEPARE/DRGARE) ──

const CELLS = ['OC-61-10ENB5', 'OC-61-10RCS5'];
// The router's rank for each cell (cellFinenessRank; the fixture's usage
// bands: tests/helpers/corridorCellRanks.ts CORRIDOR_CELL_SCALE).
const rankOf = Object.fromEntries(CELLS.map((id) => [id, cellFinenessRank(CORRIDOR_CELL_SCALE[id])]));
function layer(name: string, ranked = false): Feature[] {
    return CELLS.flatMap((id) =>
        (encCell(id).layers[name]?.features ?? []).map((f) =>
            ranked ? { ...f, properties: { ...(f.properties ?? {}), _scaleRank: rankOf[id] } } : f,
        ),
    );
}
const newport = (): InshoreLayers => ({
    LNDARE: fc(layer('LNDARE', true)),
    DEPARE: fc(layer('DEPARE', true)),
    DRGARE: fc(layer('DRGARE', true)),
    FAIRWY: fc(layer('FAIRWY')),
    RECTRC: fc(layer('RECTRC')),
    NAVLINE: fc(navLineLeads(layer('NAVLNE'), 'NAVLNE')),
});

const rawLand = lazy(() =>
    layer('LNDARE').map((f) => ({
        g: f.geometry as Polygon | MultiPolygon,
        bbox: geometryBbox(f.geometry as Polygon | MultiPolygon),
    })),
);
const onLand = (lon: number, lat: number): boolean =>
    rawLand().some(
        ({ g, bbox }) =>
            lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3] && pointInGeometry(lon, lat, g),
    );
/** Metres of a polyline over raw LNDARE, by 5 m interval midpoints. */
function landM(coords: readonly Position[]): number {
    let m = 0;
    for (let i = 0; i < coords.length - 1; i++) {
        const segM = haversineM(coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0]);
        const n = Math.max(1, Math.ceil(segM / 5));
        for (let k = 0; k < n; k++) {
            const t = (k + 0.5) / n;
            if (
                onLand(
                    coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t,
                    coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t,
                )
            )
                m += segM / n;
        }
    }
    return m;
}
const partsOf = (f: Feature): Position[][] => {
    const g = f.geometry as { type: string; coordinates: unknown };
    return g.type === 'LineString' ? [g.coordinates as Position[]] : (g.coordinates as Position[][]);
};
const rcidOf = (f: Feature) => (f.properties as { rcid?: number } | null)?.rcid;

describe.skipIf(REAL_AU_CHART_FIXTURES_RETIRED)(
    'routeInshore entry: leads cut to their on-water spans (withNavLineLeadsOnly) (real AU chart fixture retired; port: 127-C-a)',
    () => {
        let layers: InshoreLayers;
        let out: InshoreLayers;
        beforeAll(() => {
            layers = newport();
            out = withNavLineLeadsOnly(layers);
        });

        it('NAVLNE 2379 and 2387 lose their land extensions (~1.1 km and ~0.95 km); no lead keeps any land', () => {
            for (const [rcid, rawLandM] of [
                [2379, 1_096],
                [2387, 949],
            ] as const) {
                const raw = layers.NAVLINE!.features.find((f) => rcidOf(f) === rcid)!;
                // Independent: the raw lead really does cross this much land.
                expect(landM(partsOf(raw)[0])).toBeGreaterThan(rawLandM - 25);
                const cut = out.NAVLINE!.features.filter((f) => rcidOf(f) === rcid);
                expect(cut).toHaveLength(1);
                expect(cut[0].geometry.type).toBe('MultiLineString');
                for (const part of partsOf(cut[0])) expect(landM(part)).toBe(0);
                // The lead's own properties ride along (CATNAV 3, the NAVLNE identity).
                expect(cut[0].properties).toMatchObject({ CATNAV: 3, rcid });
            }
            for (const f of out.NAVLINE!.features)
                for (const part of partsOf(f)) expect(landM(part), `${rcidOf(f)}`).toBe(0);
        });

        it('the grid keeps the leads as they were, for its own land verdict (NAVLINE_GRID)', () => {
            expect(out.NAVLINE_GRID?.features).toBe(layers.NAVLINE!.features);
        });

        it('recommended tracks already on water are the same objects; the layer is kept', () => {
            expect(out.RECTRC).toBe(layers.RECTRC);
        });

        it('nothing to cut: the same layer set back', () => {
            const water: InshoreLayers = { ...layers, LNDARE: fc([]) };
            expect(withNavLineLeadsOnly(water)).toBe(water);
        });

        it('still the lead gate: a clearing line never reaches any consumer', () => {
            const withClearing: InshoreLayers = { ...layers, NAVLINE: fc(layer('NAVLNE')) };
            const gated = withNavLineLeadsOnly(withClearing);
            for (const c of [gated.NAVLINE!, gated.NAVLINE_GRID!]) {
                expect(c.features.some((f) => (f.properties as { CATNAV?: number }).CATNAV !== 3)).toBe(false);
            }
        });
    },
);

describe.skipIf(REAL_AU_CHART_FIXTURES_RETIRED)(
    'the Moreton corridor: RECTRC 2655 lies wholly on land paint (real AU chart fixture retired; port: 127-C-a)',
    () => {
        let asCaptured: InshoreLayers;
        let ranked: InshoreLayers;
        beforeAll(() => {
            const fx = loadFixture('moreton-bay-tier2.corridor.json.gz');
            asCaptured = fx.cells as unknown as InshoreLayers;
            ranked = withCorridorCellRanks(
                fx.cells,
                corridorCellRanks(fx._meta.cells as string[], fx.cells),
            ) as unknown as InshoreLayers;
        });
        const has2655 = (l: InshoreLayers) => (l.RECTRC?.features ?? []).some((f) => rcidOf(f) === 2655);

        it('unranked (the capture as it is): the land paint stands and the track is gone', () => {
            expect(has2655(asCaptured)).toBe(true);
            expect(has2655(withNavLineLeadsOnly(asCaptured))).toBe(false);
        });

        it('ranked as production merges it: a finer never-drying band beats the overview paint, and it stays', () => {
            const out = withNavLineLeadsOnly(ranked);
            expect(has2655(out)).toBe(true);
            // Kept whole: its water is the finer survey's (the lead compiler
            // classes it 'needs tide', never clear — tests/leadCompiler).
            const f = out.RECTRC!.features.find((x) => rcidOf(x) === 2655)!;
            expect(f).toBe(ranked.RECTRC!.features.find((x) => rcidOf(x) === 2655));
        });
    },
);

describe.skipIf(REAL_AU_CHART_FIXTURES_RETIRED)(
    'tracer context: tap-snap and ridingLeadAt read on-water spans only (real AU chart fixture retired; port: 127-C-a)',
    () => {
        let ctx: ReturnType<typeof tracerContextFromLayers>;
        beforeAll(() => {
            ctx = tracerContextFromLayers(newport(), [], [153.0, -27.5, 153.4, -27.0], 1.9, { skipGrid: true });
        });

        it('no chart lead or chart track the tracer holds runs over land', () => {
            for (const l of ctx.leads) expect(landM(l.pts.map((p) => [p.lon, p.lat]))).toBe(0);
            for (const t of ctx.chartTracks ?? [])
                expect(landM(t.pts.map((p) => [p.lon, p.lat])), t.chartTrack.id).toBe(0);
        });

        it('NAVLNE 2379 is still there as a lead — its on-water span', () => {
            const spans = (ctx.chartTracks ?? []).filter((t) => t.chartTrack.featureId === '2379');
            expect(spans.length).toBeGreaterThan(0);
            expect(spans.every((t) => t.chartTrack.kind === 'leading-line')).toBe(true);
        });
    },
);
