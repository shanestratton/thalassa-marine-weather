/**
 * Phase 1 (inshore router), on the real Newport cells: a leading line's
 * extension over land is not evidence of water.
 *
 * NAVLNE 2379 and 2387 (CATNAV 3, OC-61-10ENB5) run on over charted LNDARE
 * towards their leading marks ashore: ~1.1 km and ~0.95 km of land in all. Before
 * Phase 1 the final land audit read everything within 125 m of any lead as
 * proven water, so a route laid along either land extension passed the audit
 * with 0 m of hard land. The land runs here are measured independently of the
 * clipping module (5 m samples against the raw LNDARE polygons).
 */
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from 'geojson';
import { describe, expect, it } from 'vitest';
import { geometryBbox, haversineM, pointInGeometry } from '../../services/engine/geometry';
import { auditUnvouchedHardLand, MAX_UNVOUCHED_HARD_LAND_RUN_M } from '../../services/engine/safetyAudit';
import type { InshoreLayers } from '../../services/engine/types';
import { navLineLeads } from '../../services/leadingLine';
import { encCell } from '../helpers/encCells';

const CELLS = ['OC-61-10ENB5', 'OC-61-10RCS5'];
const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });

function layer(name: string): Feature[] {
    return CELLS.flatMap((id) => encCell(id).layers[name]?.features ?? []);
}

const layers: InshoreLayers = {
    LNDARE: fc(layer('LNDARE')),
    DEPARE: fc(layer('DEPARE')),
    DRGARE: fc(layer('DRGARE')),
    FAIRWY: fc(layer('FAIRWY')),
    RECTRC: fc(layer('RECTRC')),
    NAVLINE: fc(navLineLeads(layer('NAVLNE'), 'NAVLNE')),
};

const land = layer('LNDARE').map((f) => ({
    g: f.geometry as Polygon | MultiPolygon,
    bbox: geometryBbox(f.geometry as Polygon | MultiPolygon),
}));
const onLand = (lon: number, lat: number): boolean =>
    land.some(
        ({ g, bbox }) =>
            lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3] && pointInGeometry(lon, lat, g),
    );

/** The longest continuous run of the line over raw LNDARE, as a polyline, by
 * 5 m samples. */
function longestLandRun(coords: Position[]): { run: [number, number][]; lengthM: number } {
    let best: [number, number][] = [];
    let bestM = 0;
    let cur: [number, number][] = [];
    let curM = 0;
    for (let i = 0; i < coords.length - 1; i++) {
        const [lon0, lat0] = coords[i];
        const [lon1, lat1] = coords[i + 1];
        const segM = haversineM(lat0, lon0, lat1, lon1);
        const n = Math.max(1, Math.ceil(segM / 5));
        for (let s = 0; s <= n; s++) {
            const t = s / n;
            const p: [number, number] = [lon0 + (lon1 - lon0) * t, lat0 + (lat1 - lat0) * t];
            if (onLand(p[0], p[1])) {
                if (cur.length > 0) curM += haversineM(cur[cur.length - 1][1], cur[cur.length - 1][0], p[1], p[0]);
                cur.push(p);
                if (curM > bestM) {
                    bestM = curM;
                    best = [...cur];
                }
            } else {
                cur = [];
                curM = 0;
            }
        }
    }
    return { run: best, lengthM: bestM };
}

function lead(rcid: number): Position[] {
    const f = layer('NAVLNE').find((x) => x.properties?.rcid === rcid);
    if (!f || f.geometry.type !== 'LineString') throw new Error(`no NAVLNE ${rcid} in the Newport fixture`);
    expect(f.properties?.CATNAV).toBe(3);
    return f.geometry.coordinates;
}

describe('a leading line over charted land vouches no water (Newport cells)', () => {
    // Longest continuous land run (2379 has ~1.1 km of land in all, the
    // longest single run ~880 m; 2387 ~950 m in one run).
    it.each([
        [2379, 850],
        [2387, 900],
    ])('a route along the land extension of NAVLNE %i fails the land audit', (rcid, minLandM) => {
        const { run, lengthM } = longestLandRun(lead(rcid));
        // The fixture pin: this lead really does run on over land.
        expect(lengthM).toBeGreaterThan(minLandM);
        const audit = auditUnvouchedHardLand(layers, run);
        // Before Phase 1: 0 m (every sample sat within 125 m of the lead).
        // Now only the 125 m beside the lead's on-water spans stays vouched.
        expect(audit.maxRunM).toBeGreaterThan(MAX_UNVOUCHED_HARD_LAND_RUN_M);
        expect(audit.maxRunM).toBeGreaterThan(lengthM - 2 * 125 - 25);
    });

    it('the recommended track beside it is still water all the way (control)', () => {
        const g = layer('RECTRC').find((x) => x.properties?.rcid === 2380)?.geometry;
        if (g?.type !== 'LineString') throw new Error('no RECTRC 2380 LineString in the Newport fixture');
        const coords = g.coordinates.map((c) => [c[0], c[1]] as [number, number]);
        expect(auditUnvouchedHardLand(layers, coords).maxRunM).toBe(0);
    });
});
