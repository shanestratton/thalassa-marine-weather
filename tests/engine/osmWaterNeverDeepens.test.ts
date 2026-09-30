/**
 * OSM water is WATER, not DEPTH (Phase 2a round-3 review, 2026-09-30).
 *
 * The OSM overlay's water polygons (the Brisbane River multipolygon, marina
 * basins, canal side arms) carry no depth: production and the corridor
 * fixtures inject them as DEPARE with a synthetic DRVAL1 of 10 m (5 m for a
 * marina). Pass 1 let that made-up 10 m outrank the chart's own S-57 depth
 * band in BOTH feature orders, so the ENC harbour cell's DEPARE -2.2..0 at the
 * Brisbane River mouth read 10 m: ~2.9 km of every Newport → river route drew
 * a yellow 'marked channel' across ground that dries 2.2 m at LAT, with no
 * red and no tide chip.
 *
 * Now OSM water still beats chart LAND paint (the LNDARE-bleed case it was
 * trusted for), but never an S-57 DEPARE / DRGARE depth claim: a shallow or
 * drying band keeps its CAUTION (and a drying band its drying cost) whatever
 * OSM says, in either order — and so does the OSM canal-line carve.
 *
 * Between a RANKED and an UNRANKED S-57 band the shallowest wins too, in
 * either order (Claude's call, round 3, told Shane 2026-09-30 — the fail-safe
 * side: unknown fineness cannot tell a coarse overview from a harbour survey,
 * and it only ever makes water caution, never blocks).
 */
import { describe, expect, it } from 'vitest';
import type { Feature, FeatureCollection } from 'geojson';
import { buildNavGrid } from '../../services/engine/navGrid';
import type { InshoreLayers } from '../../services/engine/types';
import { CAUTION } from '../../services/engine/constants';
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

// Every test has its own bbox, so no two share a grid-cache key.
const ground = (x: number) => [153.5 + x, -26.91, 153.52 + x, -26.89] as const;
const bbox = (x: number): [number, number, number, number] => [153.49 + x, -26.92, 153.53 + x, -26.88];
const band = (x: number, drval1: number, rank: number | null, rcid: number): Feature => {
    const [x0, y0, x1, y1] = ground(x);
    return rect(x0, y0, x1, y1, {
        acronym: 'DEPARE',
        DRVAL1: drval1,
        DRVAL2: drval1 + 2,
        rcid,
        ...(rank === null ? {} : { _scaleRank: rank }),
    });
};
/** The overlay's OSM river, as production injects it (InshoreRouter: DRVAL1 10). */
const osmRiver = (x: number): Feature => {
    const [x0, y0, x1, y1] = ground(x);
    return rect(x0, y0, x1, y1, { natural: 'water', water: 'river', name: 'Brisbane River', DRVAL1: 10, DRVAL2: 10 });
};
const land = (x: number, rank: number): Feature => {
    const [x0, y0, x1, y1] = ground(x);
    return rect(x0, y0, x1, y1, { acronym: 'LNDARE', rcid: 900, _scaleRank: rank });
};

function probe(layers: InshoreLayers, x: number) {
    const g = buildNavGrid(layers, bbox(x), 50, 2.4, 0.2, 30);
    const cx = Math.floor((153.51 + x - g.minLon) / g.dLon);
    const cy = Math.floor((-26.9 - g.minLat) / g.dLat);
    const i = cy * g.width + cx;
    return {
        depth: g.cells[i],
        shallowDepthM: g.shallowDepthM?.[i],
        land: g.landBlocked?.[i] === 1,
    };
}

describe('OSM water never outranks an S-57 depth band (round-3 review, 2026-09-30)', () => {
    it('the Brisbane River mouth: OSM river over a ranked DRYING band reads drying CAUTION, either order', () => {
        for (const [i, first] of [
            [0, 'osm'],
            [1, 'chart'],
        ] as const) {
            const x = i * 0.05;
            const feats =
                first === 'osm' ? [osmRiver(x), band(x, -2.2, 5566, 1)] : [band(x, -2.2, 5566, 1), osmRiver(x)];
            const r = probe({ DEPARE: fc(...feats) } as InshoreLayers, x);
            expect(r.depth, `${first} first`).toBe(CAUTION);
            expect(r.shallowDepthM, `${first} first`).toBeCloseTo(-2.2, 5);
        }
    });

    it('OSM water over a ranked or an unranked SHALLOW band reads CAUTION, either order', () => {
        let x = 0.1;
        for (const rank of [5566, null]) {
            for (const first of ['osm', 'chart'] as const) {
                const feats = first === 'osm' ? [osmRiver(x), band(x, 1, rank, 1)] : [band(x, 1, rank, 1), osmRiver(x)];
                const r = probe({ DEPARE: fc(...feats) } as InshoreLayers, x);
                expect(r.depth, `rank ${rank}, ${first} first`).toBe(CAUTION);
                expect(r.shallowDepthM).toBe(1);
                x += 0.05;
            }
        }
    });

    it('a deep S-57 band under OSM water stays deep', () => {
        const x = 0.35;
        const r = probe({ DEPARE: fc(osmRiver(x), band(x, 6, 5566, 1)) } as InshoreLayers, x);
        expect(r.depth).toBeGreaterThanOrEqual(6);
    });

    it('OSM water still beats chart LAND paint (the LNDARE-bleed case it is trusted for)', () => {
        const x = 0.4;
        const r = probe({ LNDARE: fc(land(x, 3000)), DEPARE: fc(osmRiver(x)) } as InshoreLayers, x);
        expect(r.land).toBe(false);
        expect(r.depth).toBe(10);
        // Over a never-drying S-57 band it is shallow water: CAUTION, not land.
        const x1 = 0.42;
        const r1 = probe(
            { LNDARE: fc(land(x1, 3000)), DEPARE: fc(osmRiver(x1), band(x1, 1, 5566, 1)) } as InshoreLayers,
            x1,
        );
        expect(r1.land).toBe(false);
        expect(r1.depth).toBe(CAUTION);
    });

    it('…but not where the chart’s own band DRIES: land paint over a drying bank stands (decision 1)', () => {
        // The chart says it twice — land paint over a band that dries, which
        // decision 1 never lets a drying band beat — and OSM water has no
        // depth to say otherwise (the Brisbane River mouth, 2026-09-30).
        for (const [i, first] of [
            [0, 'osm'],
            [1, 'chart'],
        ] as const) {
            const x = 0.45 + i * 0.02;
            const feats =
                first === 'osm' ? [osmRiver(x), band(x, -2.2, 5566, 1)] : [band(x, -2.2, 5566, 1), osmRiver(x)];
            const r = probe({ LNDARE: fc(land(x, 3000)), DEPARE: fc(...feats) } as InshoreLayers, x);
            expect(r.land, `${first} first`).toBe(true);
        }
        // Only the CHART's drying claim counts: public bathymetry (neither
        // S-57 nor OSM) saying it dries leaves the OSM water standing over
        // the chart's never-drying 1 m band.
        const x = 0.49;
        const [x0, y0, x1, y1] = ground(x);
        const gmrt = rect(x0, y0, x1, y1, { DRVAL1: -1, DRVAL2: 0, _source: 'GMRT', _grade: 'D' });
        const r = probe(
            { LNDARE: fc(land(x, 3000)), DEPARE: fc(gmrt, osmRiver(x), band(x, 1, 5566, 1)) } as InshoreLayers,
            x,
        );
        expect(r.land).toBe(false);
        expect(r.depth).toBe(CAUTION);
    });

    it('the OSM canal-line carve never paints a charted shallow band deep', () => {
        const x = 0.5;
        const canal: Feature = {
            type: 'Feature',
            properties: { waterway: 'canal' },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [153.5 + x, -26.9],
                    [153.52 + x, -26.9],
                ],
            },
        };
        const r = probe({ DEPARE: fc(band(x, 0.5, 5566, 1)), CANAL: fc(canal) } as InshoreLayers, x);
        expect(r.depth).toBe(CAUTION);
        expect(r.shallowDepthM).toBe(0.5);
    });
});

describe("ranked vs unranked S-57 bands: the shallowest wins (Claude's call, told Shane 2026-09-30)", () => {
    it('a ranked deep band and an unranked shallow one read CAUTION in either order', () => {
        for (const [i, first] of [
            [0, 'unranked'],
            [1, 'ranked'],
        ] as const) {
            const x = 0.6 + i * 0.05;
            const feats =
                first === 'unranked'
                    ? [band(x, 1, null, 1), band(x, 6, 4540, 2)]
                    : [band(x, 6, 4540, 2), band(x, 1, null, 1)];
            const r = probe({ DEPARE: fc(...feats) } as InshoreLayers, x);
            expect(r.depth, `${first} first`).toBe(CAUTION);
            expect(r.shallowDepthM).toBe(1);
        }
    });

    it('a finer ranked band resetting a coarser one never wipes an unranked shallow claim', () => {
        const x = 0.7;
        // unranked 1 m, coarse ranked 3 m, finer ranked 6 m: the finer band
        // resets the coarse band's claim, but the unranked 1 m still stands.
        const r = probe(
            { DEPARE: fc(band(x, 1, null, 1), band(x, 3, 3540, 2), band(x, 6, 5540, 3)) } as InshoreLayers,
            x,
        );
        expect(r.depth).toBe(CAUTION);
        expect(r.shallowDepthM).toBe(1);
    });

    it('chartedDepthAt agrees: the shallowest of the finest ranked and the unranked bands', () => {
        const x = 0.8;
        const index = buildChartAreaIndex({
            DEPARE: fc(band(x, 6, 4540, 2), band(x, 1, null, 1), band(x, 0, 3540, 3)),
        });
        // The coarse ranked 0 m band is out-surveyed by the 4540 band; the
        // unranked 1 m band cannot be told coarser, so it counts.
        expect(chartedDepthAt(index.depth, 153.51 + x, -26.9)).toBe(1);
    });
});
