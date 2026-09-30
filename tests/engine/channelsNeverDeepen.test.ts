/**
 * Leads, fairways and dredged areas never fabricate depth, and never reopen
 * land (Phase 2a review, 2026-09-30).
 *
 * Owner decisions (Shane, 2026-09-29/30), binding: leads never override land,
 * hazards or depth; unknown data is never green; a coarse chart's land paint
 * over a FINER survey's never-drying band is shallow water — 'needs tide',
 * never clear (decision 1).
 *
 * Two older grid passes broke all three:
 *   • Pass 5b's lead brush turned every CAUTION or UNKNOWN cell within a cell
 *     of a lead into 5 m preferred water — decision-1 water, charted-shallow
 *     water and uncharted water alike (12 of the 31 CATNAV-3 leads on the real
 *     newport-shane cells, up to 199 cells a lead);
 *   • Pass 4 wrote a 5 m "rescue depth" into every shallow, blocked or land
 *     cell under a chart FAIRWY or DRGARE — over land at any scale, over
 *     conflict water, over a 1.3 m dredged area for a 2.4 m keel, and over a
 *     charted hazard's buffer.
 * Both now only PREFER the channel (A* rides it at 1.0x); depth comes from the
 * chart's depth bands — a DRGARE's own DRVAL1 among them — and land from the
 * land passes.
 */
import type { Feature, FeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';
import { buildNavGrid } from '../../services/engine/navGrid';
import { routeInshore } from '../../services/inshoreRouterEngine';
import { CAUTION, UNKNOWN_OPEN } from '../../services/engine/constants';
import type { InshoreLayers, NavGrid } from '../../services/engine/types';

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

// Same geometry as chartWaterUnderLandPaint.test.ts: a 2 km square of land
// paint over a band of the same extent; the probe is its middle cell.
const BBOX: [number, number, number, number] = [152.49, -27.92, 152.53, -27.88];
const LAND = (props: Record<string, unknown> = {}) => rect(152.5, -27.91, 152.52, -27.89, props);
const BAND = (props: Record<string, unknown>) => rect(152.498, -27.912, 152.522, -27.888, props);
const depare = (DRVAL1: unknown, extra: Record<string, unknown> = {}) =>
    BAND({ acronym: 'DEPARE', DRVAL1, DRVAL2: 10, ...extra });
const drgare = (DRVAL1: unknown, extra: Record<string, unknown> = {}) => BAND({ acronym: 'DRGARE', DRVAL1, ...extra });
const fairwy = (extra: Record<string, unknown> = {}) => BAND({ acronym: 'FAIRWY', ...extra });
/** A charted leading line (NAVLNE CATNAV 3) straight through the probe cell. */
const LEAD: Feature = {
    type: 'Feature',
    properties: { acronym: 'NAVLNE', CATNAV: 3 },
    geometry: {
        type: 'LineString',
        coordinates: [
            [152.495, -27.9],
            [152.525, -27.9],
        ],
    },
};

const COARSE = 100;
const FINE = 200;
const DRAFT = 2.4;

function build(layers: InshoreLayers): NavGrid {
    // 2.4 m draft + 0.5 m: a 5 m band is deep, a 1 m band shallow.
    return buildNavGrid(layers, BBOX, 50, DRAFT, 0.5, 60);
}
function probe(g: NavGrid, lon = 152.51, lat = -27.9) {
    const x = Math.floor((lon - g.minLon) / g.dLon);
    const y = Math.floor((lat - g.minLat) / g.dLat);
    const i = y * g.width + x;
    const v = g.cells[i];
    return {
        value: v,
        land: g.landBlocked?.[i] === 1,
        blocked: Number.isNaN(v),
        caution: v === CAUTION,
        unknown: v === UNKNOWN_OPEN,
        deep: v > 0,
        preferred: g.preferred[i] === 1,
        wetConflict: g.wetConflict?.[i] === 1,
        unvouched: g.unvouched?.[i] === 1,
        shallowDepthM: g.shallowDepthM?.[i],
    };
}

describe('Pass 5b — a lead prefers its channel and never deepens it', () => {
    it('decision-1 water (a finer 1 m band under coarse land paint) stays CAUTION under a lead', () => {
        const base: InshoreLayers = {
            LNDARE: fc(LAND({ _scaleRank: COARSE })),
            DEPARE: fc(depare(1, { _scaleRank: FINE })),
        };
        expect(probe(build(base))).toMatchObject({ caution: true, wetConflict: true });
        const led = probe(build({ ...base, NAVLINE: fc(LEAD) }));
        expect(led).toMatchObject({ caution: true, deep: false, wetConflict: true, shallowDepthM: 1 });
    });

    it('open water charted 1 m stays CAUTION under a lead, keeping its charted depth for the tide window', () => {
        const led = probe(build({ DEPARE: fc(depare(1)), NAVLINE: fc(LEAD) }));
        expect(led).toMatchObject({ caution: true, deep: false, preferred: true, shallowDepthM: 1 });
    });

    it('a charted 0 m band stays CAUTION under a lead', () => {
        expect(probe(build({ DEPARE: fc(depare(0)), NAVLINE: fc(LEAD) }))).toMatchObject({
            caution: true,
            deep: false,
        });
    });

    it('uncharted water under a lead stays unknown and unvouched: never green', () => {
        const led = probe(build({ NAVLINE: fc(LEAD) }));
        expect(led).toMatchObject({ unknown: true, deep: false, unvouched: true });
    });

    it('deep charted water under a lead keeps its own depth and is preferred', () => {
        expect(probe(build({ DEPARE: fc(depare(12)), NAVLINE: fc(LEAD) }))).toMatchObject({
            value: 12,
            preferred: true,
        });
    });
});

describe('Pass 1 — the finest survey owns the depth, whatever the feature order', () => {
    it('a finer shallow band beats a coarser deep band in either order', () => {
        const coarseDeep = depare(10, { _scaleRank: COARSE });
        const fineShallow = depare(1, { _scaleRank: FINE });
        for (const bands of [
            [coarseDeep, fineShallow],
            [fineShallow, coarseDeep],
        ]) {
            expect(probe(build({ DEPARE: fc(...bands) }))).toMatchObject({
                caution: true,
                deep: false,
                shallowDepthM: 1,
            });
        }
    });

    // RE-PIN (round-3 review, 2026-09-30): was { deep: true } — the OSM
    // river's synthetic 10 m outranked the chart's own 1 m band. OSM water is
    // water, not depth: it still keeps the cell from land paint, but the
    // finer chart band's shallow claim stands (the Brisbane River mouth drew
    // ~2.9 km of charted drying bank as a deep yellow channel;
    // tests/engine/osmWaterNeverDeepens.test.ts).
    it('OSM-vouched water keeps the cell water, but a finer chart band’s shallow claim stands', () => {
        const osmRiver = BAND({ natural: 'water', water: 'river', DRVAL1: 10, DRVAL2: 10 });
        expect(probe(build({ DEPARE: fc(osmRiver, depare(1, { _scaleRank: FINE })) }))).toMatchObject({
            deep: false,
            caution: true,
            shallowDepthM: 1,
        });
    });
});

describe('Pass 4 — a chart fairway or dredged area prefers its channel and never deepens or reopens it', () => {
    it.each([
        [
            'an equal-rank 3 m DRGARE over land',
            { LNDARE: fc(LAND({ _scaleRank: FINE })), DRGARE: fc(drgare(3, { _scaleRank: FINE })) },
        ],
        [
            'a coarser 1 m DRGARE over finer land',
            { LNDARE: fc(LAND({ _scaleRank: FINE })), DRGARE: fc(drgare(1, { _scaleRank: COARSE })) },
        ],
        ['a chart FAIRWY over finer land', { LNDARE: fc(LAND({ _scaleRank: FINE })), FAIRWY: fc(fairwy()) }],
        ['unranked land and an unranked DRGARE', { LNDARE: fc(LAND()), DRGARE: fc(drgare(5)) }],
    ] as [string, InshoreLayers][])('%s stays land', (_name, layers) => {
        expect(probe(build(layers))).toMatchObject({ land: true, blocked: true, deep: false });
    });

    it('decision-1 water under a FAIRWY stays CAUTION', () => {
        const g = probe(
            build({
                LNDARE: fc(LAND({ _scaleRank: COARSE })),
                DEPARE: fc(depare(5, { _scaleRank: FINE })),
                FAIRWY: fc(fairwy()),
            }),
        );
        expect(g).toMatchObject({ caution: true, deep: false, wetConflict: true, preferred: true });
    });

    it('a finer 0.5 m DRGARE under coarse land paint is shallow conflict water at its own depth', () => {
        const g = probe(
            build({ LNDARE: fc(LAND({ _scaleRank: COARSE })), DRGARE: fc(drgare(0.5, { _scaleRank: FINE })) }),
        );
        expect(g).toMatchObject({ caution: true, deep: false, wetConflict: true, shallowDepthM: 0.5 });
    });

    it('a finer deep DRGARE under coarse land paint is conflict water: CAUTION, never deep', () => {
        const g = probe(
            build({ LNDARE: fc(LAND({ _scaleRank: COARSE })), DRGARE: fc(drgare(8, { _scaleRank: FINE })) }),
        );
        expect(g).toMatchObject({ caution: true, deep: false, wetConflict: true });
    });

    it('open water charted 1 m under a FAIRWY stays CAUTION', () => {
        expect(probe(build({ DEPARE: fc(depare(1)), FAIRWY: fc(fairwy()) }))).toMatchObject({
            caution: true,
            deep: false,
            preferred: true,
            shallowDepthM: 1,
        });
    });

    it('a 1.3 m dredged area (the Newport corridor DRGARE 4295) reads its own 1.3 m for a 2.4 m keel', () => {
        expect(probe(build({ DRGARE: fc(drgare(1.3)) }))).toMatchObject({
            caution: true,
            deep: false,
            preferred: true,
            shallowDepthM: expect.closeTo(1.3, 5),
        });
        // …also over a coarser deep DEPARE band it lies in: the dredged area
        // is the finer, shallower claim.
        expect(
            probe(
                build({
                    DEPARE: fc(depare(10, { _scaleRank: COARSE })),
                    DRGARE: fc(drgare(1.3, { _scaleRank: FINE })),
                }),
            ),
        ).toMatchObject({ caution: true, deep: false, shallowDepthM: expect.closeTo(1.3, 5) });
    });

    it('a deep dredged area reads its own charted depth, not a fabricated 5 m', () => {
        expect(probe(build({ DRGARE: fc(drgare(12)) }))).toMatchObject({ value: 12, preferred: true });
    });

    it('a dredged area with no charted depth is not clear water', () => {
        expect(probe(build({ DRGARE: fc(drgare(undefined)) }))).toMatchObject({ caution: true, deep: false });
    });

    it('a chart FAIRWY over uncharted water adds no depth', () => {
        expect(probe(build({ FAIRWY: fc(fairwy()) }))).toMatchObject({ unknown: true, deep: false, preferred: true });
    });

    // Phase 2a round-2 review (2026-09-30): a fairway, a dredged area's outline
    // or the synthetic lateral-mark ribbon says where the channel is, not that
    // there is water — the same rule as Pass 5's gate discs and Pass 5b's
    // leads. Pass 4 set `preferred` without `leadOnlyPreferred`, so an
    // uncharted cell under any of them counted as vouched water, and a strict
    // route across a 1.9 NM uncharted gap read all green.
    it('uncharted water under a chart FAIRWY or the mark ribbon stays unvouched: never green', () => {
        for (const extra of [{}, { _class: 'synthetic-channel-segment' }, { _promotePreferred: true }]) {
            const g = probe(build({ FAIRWY: fc(fairwy(extra)) }));
            expect(g, JSON.stringify(extra)).toMatchObject({ unknown: true, preferred: true, unvouched: true });
        }
    });

    it('charted water under a FAIRWY is still vouched (the band is the evidence, not the fairway)', () => {
        for (const d of [1, 12]) {
            expect(probe(build({ DEPARE: fc(depare(d)), FAIRWY: fc(fairwy()) })).unvouched).toBe(false);
        }
    });

    it('a charted hazard inside a dredged area or fairway stays blocked', () => {
        const wreck: Feature = {
            type: 'Feature',
            properties: { acronym: 'WRECKS' },
            geometry: { type: 'Point', coordinates: [152.51, -27.9] },
        };
        for (const channel of [{ DRGARE: fc(drgare(12)) }, { DEPARE: fc(depare(12)), FAIRWY: fc(fairwy()) }]) {
            expect(probe(build({ ...channel, WRECKS: fc(wreck) }))).toMatchObject({ blocked: true, deep: false });
        }
    });
});

/** A paired lateral-mark midpoint (InshoreRouter Step 5) on the probe cell. */
const MIDPOINT: Feature = {
    type: 'Feature',
    properties: { _pairDistanceM: 200 },
    geometry: { type: 'Point', coordinates: [152.51, -27.9] },
};

describe('Pass 5 — a paired channel midpoint prefers its gate and never deepens it (round 2, 2026-09-30)', () => {
    it('open water charted 1 m between a pair of marks stays CAUTION with its charted depth', () => {
        // Was: the gate disc wrote a 5 m "rescue depth" here for a 2.4 m keel.
        expect(probe(build({ DEPARE: fc(depare(1)), BOYLAT: fc(MIDPOINT) }))).toMatchObject({
            caution: true,
            deep: false,
            preferred: true,
            shallowDepthM: 1,
        });
    });

    it('a charted 0 m band between the marks stays CAUTION', () => {
        expect(probe(build({ DEPARE: fc(depare(0)), BOYLAT: fc(MIDPOINT) }))).toMatchObject({
            caution: true,
            deep: false,
            preferred: true,
        });
    });

    it('uncharted water between the marks stays unknown and unvouched: never green', () => {
        expect(probe(build({ BOYLAT: fc(MIDPOINT) }))).toMatchObject({
            unknown: true,
            deep: false,
            preferred: true,
            unvouched: true,
        });
    });

    it('deep charted water between the marks keeps its own depth', () => {
        expect(probe(build({ DEPARE: fc(depare(12)), BOYLAT: fc(MIDPOINT) }))).toMatchObject({
            value: 12,
            preferred: true,
        });
    });

    it('a beacon pair (BCNLAT) reads the same', () => {
        expect(probe(build({ DEPARE: fc(depare(1)), BCNLAT: fc(MIDPOINT) }))).toMatchObject({
            caution: true,
            deep: false,
            shallowDepthM: 1,
        });
    });

    it('decision-1 water under a pair midpoint stays CAUTION', () => {
        const midpoint = MIDPOINT;
        const g = probe(
            build({
                LNDARE: fc(LAND({ _scaleRank: COARSE })),
                DEPARE: fc(depare(1, { _scaleRank: FINE })),
                BOYLAT: fc(midpoint),
            }),
        );
        expect(g).toMatchObject({ caution: true, deep: false, wetConflict: true });
    });
});

describe('a strict route across an uncharted gap is refused, ribbon or no ribbon (round-2 review, 2026-09-30)', () => {
    // Deep charted water either side of a ~1.9 NM gap no chart covers (scenario F).
    // The ribbon and fairway are ~1.1 km wide so the strict 400 m coarse
    // pre-check sees them too (a narrower one is refused there, before the
    // fine grid is asked).
    const west = rect(152.4, -27.91, 152.43, -27.89, { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 20 });
    const east = rect(152.465, -27.91, 152.495, -27.89, { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 20 });
    const ribbon = rect(152.4, -27.905, 152.495, -27.895, { _class: 'synthetic-channel-segment' });
    const req = {
        fromLat: -27.9,
        fromLon: 152.405,
        toLat: -27.9,
        toLon: 152.49,
        draftM: 2.4,
        unchartedPolicy: 'strict' as const,
    };

    it('without a ribbon: refused as uncharted', () => {
        const r = routeInshore({ DEPARE: fc(west, east) }, req);
        expect('error' in r && r.code).toBe('uncharted-corridor');
    });

    it('with the lateral-mark ribbon across the gap: still refused — marks are not water', () => {
        const r = routeInshore({ DEPARE: fc(west, east), FAIRWY: fc(ribbon) }, { ...req, toLon: 152.4901 });
        expect('error' in r && r.code).toBe('uncharted-corridor');
    });

    it('with a chart FAIRWY across the gap: still refused', () => {
        const fairway = rect(152.4, -27.905, 152.495, -27.895, { acronym: 'FAIRWY' });
        const r = routeInshore({ DEPARE: fc(west, east), FAIRWY: fc(fairway) }, { ...req, toLon: 152.4902 });
        expect('error' in r && r.code).toBe('uncharted-corridor');
    });
});
