/**
 * Survey fineness TIES and "the shallowest wins" (Phase 2a round-2 review,
 * 2026-09-30).
 *
 * A cell's fineness rank is usage band × 1000 + a within-band step that exists
 * only when its compilation scale is known (services/enc/scaleShadow.ts
 * cellFinenessRank). A cell known by its S-57 name alone has step 0 —
 * "somewhere in this band" — so it may be as fine as any same-band cell whose
 * scale is known. Ranking the known one finer let it silently outrank a
 * same-band chart that says the ground dries (G3) or is shallower (D1). Two
 * ranks of one usage band where either has step 0 are a TIE: the shallowest
 * band wins the depth, a drying band makes decision 1's claim BAND_NO, and the
 * land paint stands.
 *
 * And at a tie — the same rank, or tied ranks — the DEEPER band's own
 * protection no longer outranks the shallower survey (G1, G2): only OSM-vouched
 * water or a strictly finer survey protects a cell against a shallow S-57
 * band.
 */
import { describe, expect, it } from 'vitest';
import type { Feature, FeatureCollection } from 'geojson';
import { buildNavGrid, navGridCacheKey } from '../../services/engine/navGrid';
import type { InshoreLayers } from '../../services/engine/types';
import { CAUTION } from '../../services/engine/constants';
import { compareSurveyRanks, finestSurveyOwners, surveyRanksTie } from '../../services/enc/scaleShadow';
import { buildChartAreaIndex, chartedDepthAt } from '../../services/routing/leadLandClip';
import { bandClaimOf, finestBandBeatsLand } from '../../services/engine/chartWaterEvidence';
import { hardLandAtPoint } from '../../services/engine/safetyAudit';

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

// Every bbox in this file is its own, so no two tests share a grid-cache key.
const ground = (x: number) => [152.5 + x, -27.91, 152.52 + x, -27.89] as const;
const bbox = (x: number): [number, number, number, number] => [152.49 + x, -27.92, 152.53 + x, -27.88];
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
const land = (x: number, rank: number): Feature => {
    const [x0, y0, x1, y1] = ground(x);
    return rect(x0, y0, x1, y1, { acronym: 'LNDARE', rcid: 900, _scaleRank: rank });
};

function probe(layers: InshoreLayers, x: number) {
    const g = buildNavGrid(layers, bbox(x), 50, 2.4, 1.0, 30);
    const cx = Math.floor((152.51 + x - g.minLon) / g.dLon);
    const cy = Math.floor((-27.9 - g.minLat) / g.dLat);
    const i = cy * g.width + cx;
    return {
        depth: g.cells[i],
        shallowDepthM: g.shallowDepthM?.[i],
        land: g.landBlocked?.[i] === 1,
        wetConflict: g.wetConflict?.[i] === 1,
    };
}

describe('survey rank ties (scaleShadow)', () => {
    it('same usage band with either rank known by its band alone is a tie; two known scales are not', () => {
        expect(surveyRanksTie(4540, 4000)).toBe(true);
        expect(surveyRanksTie(4000, 4540)).toBe(true);
        expect(surveyRanksTie(4540, 4540)).toBe(true);
        expect(surveyRanksTie(4540, 4100)).toBe(false);
        expect(surveyRanksTie(5000, 4000)).toBe(false);
        expect(compareSurveyRanks(4540, 4000)).toBe(0);
        expect(compareSurveyRanks(4540, 4100)).toBeGreaterThan(0);
        expect(compareSurveyRanks(5000, 4540)).toBeGreaterThan(0);
    });

    it('the finest owners are the finest rank and every rank tied with it; the owning rank is the weakest', () => {
        expect(finestSurveyOwners([4540, 4000, 4100])).toEqual({ owners: [0, 1], rank: 4000 });
        expect(finestSurveyOwners([4540, 4100])).toEqual({ owners: [0], rank: 4540 });
        expect(finestSurveyOwners([null, 3000])).toEqual({ owners: [1], rank: 3000 });
        expect(finestSurveyOwners([null, null])).toEqual({ owners: [0, 1], rank: null });
        expect(finestSurveyOwners([])).toEqual({ owners: [], rank: null });
    });
});

describe('the grid: a tie is the shallowest band, and a drying tie keeps the land paint', () => {
    it('G3: band-3 land, a known band-4 never-drying 2 m band and a name-only band-4 DRYING band — land stands', () => {
        const x = 0;
        const layers: InshoreLayers = {
            LNDARE: fc(land(x, 3000)),
            DEPARE: fc(band(x, 2, 4540, 1), band(x, -1, 4000, 2)),
        } as InshoreLayers;
        expect(probe(layers, x)).toMatchObject({ land: true, wetConflict: false });
        // Either feature order.
        const reversed: InshoreLayers = {
            LNDARE: fc(land(x + 0.1, 3000)),
            DEPARE: fc(band(x + 0.1, -1, 4000, 2), band(x + 0.1, 2, 4540, 1)),
        } as InshoreLayers;
        expect(probe(reversed, x + 0.1)).toMatchObject({ land: true, wetConflict: false });
    });

    it('D1: 6 m at a known band-4 scale beside 1 m known by its band alone reads 1 m CAUTION, not 6 m', () => {
        const x = 0.2;
        const r = probe({ DEPARE: fc(band(x, 6, 4540, 1), band(x, 1, 4000, 2)) } as InshoreLayers, x);
        expect(r.depth).toBe(CAUTION);
        expect(r.shallowDepthM).toBe(1);
    });

    it('G1/G2: two same-rank S-57 bands, 6 m and 1 m, read 1 m CAUTION in either order', () => {
        for (const [i, order] of [
            [0, [6, 1]],
            [1, [1, 6]],
        ] as const) {
            const x = 0.3 + i * 0.1;
            const layers = { DEPARE: fc(...order.map((d, k) => band(x, d, 4540, k + 1))) } as InshoreLayers;
            const r = probe(layers, x);
            expect(r.depth, `order ${order.join('→')}`).toBe(CAUTION);
            expect(r.shallowDepthM).toBe(1);
        }
    });

    // RE-PIN (round 3, 2026-09-30 — Claude's call, told Shane 2026-09-30; the
    // round-3 review found no owner answer behind the earlier "Shane" label):
    // two UNRANKED S-57 bands that disagree — the shallowest wins. The safe
    // side: it only makes water amber ('needs tide'), never blocks. Was: the
    // deep claim won (pinned by the round-2 fix-up as a question for Shane:
    // unknown fineness cannot tell a coarse overview's generalised 0 m band
    // from a harbour survey).
    it("two UNRANKED S-57 bands that disagree: the shallowest wins, in either order (Claude's call, told Shane 2026-09-30)", () => {
        for (const [i, order] of [
            [0, [6, 1]],
            [1, [1, 6]],
        ] as const) {
            const x = 0.5 + i * 0.05;
            const r = probe({ DEPARE: fc(...order.map((d, k) => band(x, d, null, k + 1))) } as InshoreLayers, x);
            expect(r.depth, `order ${order.join('→')}`).toBe(CAUTION);
            expect(r.shallowDepthM).toBe(1);
        }
    });

    // RE-PIN (round-3 review, 2026-09-30; the ranked-vs-unranked half is
    // Claude's call, told Shane 2026-09-30): an unranked shallow band now stands
    // against a RANKED deep one (was 6: a ranked band out-surveyed a band whose
    // scale is unknown — which may be a harbour survey), and against OSM water
    // (was 5: OSM water has no depth to offer; it still beats LAND paint —
    // tests/engine/osmWaterNeverDeepens.test.ts).
    it('…and an unranked shallow band stands against a RANKED deep one and against OSM water', () => {
        const x = 0.58;
        expect(probe({ DEPARE: fc(band(x, 1, null, 1), band(x, 6, 4540, 2)) } as InshoreLayers, x).depth).toBe(CAUTION);
        const [x0, y0, x1, y1] = ground(x + 0.01);
        const osm = rect(x0, y0, x1, y1, { natural: 'water', water: 'canal', DRVAL1: 5 });
        expect(probe({ DEPARE: fc(band(x + 0.01, 1, null, 1), osm) } as InshoreLayers, x + 0.01).depth).toBe(CAUTION);
    });

    it('a STRICTLY finer survey still owns the cell: a deep finer band beats a shallow coarser one, either order', () => {
        for (const [i, feats] of [
            [0, (x: number) => [band(x, 6, 5540, 1), band(x, 1, 4540, 2)]],
            [1, (x: number) => [band(x, 1, 4540, 2), band(x, 6, 5540, 1)]],
        ] as const) {
            const x = 0.6 + i * 0.1;
            expect(probe({ DEPARE: fc(...feats(x)) } as InshoreLayers, x).depth).toBe(6);
        }
        // RE-PIN (round-3 review, 2026-09-30; Claude's call, told Shane
        // 2026-09-30): a ranked deep band no longer beats an UNRANKED shallow one —
        // unknown fineness is never out-surveyed, the shallowest wins (was 6).
        const x = 0.8;
        expect(probe({ DEPARE: fc(band(x, 6, 4540, 1), band(x, 1, null, 2)) } as InshoreLayers, x).depth).toBe(CAUTION);
    });

    // RE-PIN (round-3 review, 2026-09-30): OSM-vouched water is water, not
    // depth. It no longer protects against a shallow S-57 band (was 5: the
    // synthetic OSM depth outranked the chart, and the Brisbane River mouth's
    // drying bank drew as a deep yellow channel). It still beats land paint.
    it('OSM-vouched water no longer protects against a shallow S-57 band (it has no depth)', () => {
        const x = 0.9;
        const [x0, y0, x1, y1] = ground(x);
        const osm = rect(x0, y0, x1, y1, { natural: 'water', water: 'canal', DRVAL1: 5 });
        const r = probe({ DEPARE: fc(osm, band(x, 1, 4540, 2)) } as InshoreLayers, x);
        expect(r.depth).toBe(CAUTION);
        expect(r.shallowDepthM).toBe(1);
    });
});

describe('the lead clip and the land audit apply the same tie', () => {
    const ix = 1.0;
    const layers = {
        LNDARE: fc(land(ix, 3000)),
        DEPARE: fc(band(ix, 2, 4540, 1), band(ix, -1, 4000, 2)),
    } as InshoreLayers;

    it('chartedDepthAt: a tie reads its shallowest band (the drying one), not the known-scale 2 m', () => {
        const index = buildChartAreaIndex(layers);
        expect(chartedDepthAt(index.depth, 152.51 + ix, -27.9)).toBe(-1);
    });

    it('finestBandBeatsLand / hardLandAtPoint: a drying band at a tied rank keeps the land paint', () => {
        const claims = layers.DEPARE!.features.map((f) => bandClaimOf(f.properties as Record<string, unknown>)!);
        expect(finestBandBeatsLand(claims, [3000])).toBe(false);
        expect(hardLandAtPoint(layers)(152.51 + ix, -27.9)).toBe(true);
    });
});

describe('the grid cache key carries the survey ranks (round-2 review, 2026-09-30)', () => {
    it('ranked and unranked copies of one layer set never share a cached grid', () => {
        const x = 1.2;
        const ranked = { LNDARE: fc(land(x, 3000)), DEPARE: fc(band(x, 2, 4540, 1)) } as InshoreLayers;
        const unranked = { LNDARE: fc(land(x, 3000)), DEPARE: fc(band(x, 2, null, 1)) } as InshoreLayers;
        const rerated = { LNDARE: fc(land(x, 3000)), DEPARE: fc(band(x, 2, 5540, 1)) } as InshoreLayers;
        const key = (l: InshoreLayers) => navGridCacheKey(l, bbox(x), 50, 2.4, 1, 30, false, []);
        expect(key(ranked)).not.toBe(key(unranked));
        expect(key(ranked)).not.toBe(key(rerated));
        expect(key(ranked)).toBe(key({ LNDARE: fc(land(x, 3000)), DEPARE: fc(band(x, 2, 4540, 1)) } as InshoreLayers));
    });
});

describe('a charted shallow band stands against public bathymetry (fix-up, 2026-09-30)', () => {
    // GMRT-derived DEPARE (grade D, neither S-57 nor OSM-vouched): a later deep
    // GMRT band used to upgrade a charted 1 m band's CAUTION to deep; in the
    // other order the CAUTION stood. Now it stands in both.
    const gmrt = (x: number) => {
        const [x0, y0, x1, y1] = ground(x);
        return rect(x0, y0, x1, y1, { DRVAL1: 20, DRVAL2: 30, _source: 'GMRT', _grade: 'D' });
    };
    it('either order: 1 m CAUTION', () => {
        for (const [i, order] of [
            [0, 'chart-first'],
            [1, 'gmrt-first'],
        ] as const) {
            const x = 1.4 + i * 0.1;
            const feats = order === 'chart-first' ? [band(x, 1, 4540, 1), gmrt(x)] : [gmrt(x), band(x, 1, 4540, 1)];
            const r = probe({ DEPARE: fc(...feats) } as InshoreLayers, x);
            expect(r.depth, order).toBe(CAUTION);
            expect(r.shallowDepthM).toBe(1);
        }
    });

    it('a ranked shallow band beats an unranked deep S-57 band in either order', () => {
        for (const [i, order] of [
            [0, 'ranked-first'],
            [1, 'unranked-first'],
        ] as const) {
            const x = 1.6 + i * 0.1;
            const ranked = band(x, 1, 4540, 1);
            const unranked = band(x, 6, null, 2);
            const feats = order === 'ranked-first' ? [ranked, unranked] : [unranked, ranked];
            expect(probe({ DEPARE: fc(...feats) } as InshoreLayers, x).depth, order).toBe(CAUTION);
        }
    });
});
