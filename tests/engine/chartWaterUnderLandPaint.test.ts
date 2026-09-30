/**
 * Chart water under land paint — owner decision 1 (2026-09-30), in the grid.
 *
 * A coarse chart's LNDARE painted over a FINER survey's DEPARE/DRGARE band
 * that never dries (DRVAL1 ≥ 0) is shallow WATER, not land: CAUTION, never
 * deep, flagged wetConflict. Only a strictly finer band beats the land paint;
 * a drying band, a band at the same or a coarser scale, and an unknown rank on
 * either side leave it land (fail safe). OSM-vouched water keeps its own rule.
 *
 * The lead compiler's land clip decides the same thing (tests/leadCompiler);
 * both read services/enc/scaleShadow.ts finerBandBeatsLand.
 */
import type { Feature, FeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';
import { buildNavGrid } from '../../services/engine/navGrid';
import { CAUTION } from '../../services/engine/constants';
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

// A 2 km square of land paint over a band of the same extent; the probe cell
// is the middle of it, well clear of every edge and the Pass 6 land skin.
const BBOX: [number, number, number, number] = [152.49, -27.92, 152.53, -27.88];
const LAND = (props: Record<string, unknown> = {}) => rect(152.5, -27.91, 152.52, -27.89, props);
const BAND = (props: Record<string, unknown>) => rect(152.498, -27.912, 152.522, -27.888, props);
const depare = (DRVAL1: unknown, extra: Record<string, unknown> = {}) =>
    BAND({ acronym: 'DEPARE', DRVAL1, DRVAL2: 10, ...extra });
const drgare = (DRVAL1: unknown, extra: Record<string, unknown> = {}) => BAND({ acronym: 'DRGARE', DRVAL1, ...extra });

const COARSE = 100;
const FINE = 200;

function build(layers: InshoreLayers): NavGrid {
    // 2.4 m draft + 0.5 m: a 5 m band is deep, a 1 m band shallow.
    return buildNavGrid(layers, BBOX, 50, 2.4, 0.5, 60);
}
function probe(g: NavGrid) {
    const x = Math.floor((152.51 - g.minLon) / g.dLon);
    const y = Math.floor((-27.9 - g.minLat) / g.dLat);
    const i = y * g.width + x;
    const v = g.cells[i];
    return {
        land: g.landBlocked?.[i] === 1,
        blocked: Number.isNaN(v),
        caution: v === CAUTION,
        deep: v > 0,
        wetConflict: g.wetConflict?.[i] === 1,
        shallowDepthM: g.shallowDepthM?.[i],
    };
}
const WATER = { land: false, blocked: false, caution: true, deep: false, wetConflict: true };
const LAND_CELL = { land: true, blocked: true, caution: false, deep: false, wetConflict: false };

describe('decision 1 — chart water under land paint (navGrid Pass 2)', () => {
    it('a finer never-drying band beats coarser land paint: caution water, never deep', () => {
        // Deep for this keel, and still CAUTION: the charts disagree.
        expect(
            probe(build({ LNDARE: fc(LAND({ _scaleRank: COARSE })), DEPARE: fc(depare(5, { _scaleRank: FINE })) })),
        ).toMatchObject(WATER);
        // Shallow: keeps its real charted depth for the tide annotator.
        expect(
            probe(build({ LNDARE: fc(LAND({ _scaleRank: COARSE })), DEPARE: fc(depare(1, { _scaleRank: FINE })) })),
        ).toMatchObject({ ...WATER, shallowDepthM: 1 });
        // DRVAL1 0 never dries (the decision says ≥ 0): water too.
        expect(
            probe(build({ LNDARE: fc(LAND({ _scaleRank: COARSE })), DEPARE: fc(depare(0, { _scaleRank: FINE })) })),
        ).toMatchObject(WATER);
    });

    it('a finer dredged area (DRGARE) that never dries beats it as a DEPARE does', () => {
        const g = probe(
            build({ LNDARE: fc(LAND({ _scaleRank: COARSE })), DRGARE: fc(drgare(3, { _scaleRank: FINE })) }),
        );
        // Conflict water like any DEPARE: CAUTION, never deep — Pass 4 no
        // longer paints a rescue depth over it (Phase 2a review).
        expect(g).toMatchObject({ land: false, blocked: false, caution: true, deep: false, wetConflict: true });
    });

    it.each([
        [
            'a drying band (DRVAL1 < 0)',
            { LNDARE: fc(LAND({ _scaleRank: COARSE })), DEPARE: fc(depare(-1, { _scaleRank: FINE })) },
        ],
        [
            'a band with no DRVAL1',
            { LNDARE: fc(LAND({ _scaleRank: COARSE })), DEPARE: fc(depare(undefined, { _scaleRank: FINE })) },
        ],
        [
            'a band at the SAME scale',
            { LNDARE: fc(LAND({ _scaleRank: FINE })), DEPARE: fc(depare(5, { _scaleRank: FINE })) },
        ],
        ['a COARSER band', { LNDARE: fc(LAND({ _scaleRank: FINE })), DEPARE: fc(depare(5, { _scaleRank: COARSE })) }],
        [
            'unranked land paint (unknown: fail safe)',
            { LNDARE: fc(LAND()), DEPARE: fc(depare(5, { _scaleRank: FINE })) },
        ],
        ['an unranked band (unknown: fail safe)', { LNDARE: fc(LAND({ _scaleRank: COARSE })), DEPARE: fc(depare(5)) }],
        ['no ranks at all (unknown: fail safe)', { LNDARE: fc(LAND()), DEPARE: fc(depare(5)) }],
        ['a shallow band with no ranks (unknown: fail safe)', { LNDARE: fc(LAND()), DEPARE: fc(depare(1)) }],
    ] as [string, InshoreLayers][])('%s leaves the land paint standing', (_name, layers) => {
        expect(probe(build(layers))).toMatchObject(LAND_CELL);
    });

    it('an equal-scale dredged area leaves the land paint standing', () => {
        const g = probe(build({ LNDARE: fc(LAND({ _scaleRank: FINE })), DRGARE: fc(drgare(3, { _scaleRank: FINE })) }));
        // Land by this decision — and it stays land: Pass 4's older rule (a
        // chart DRGARE or FAIRWY "gets the keys back" over any land paint, at
        // a 5 m rescue depth) is gone (Phase 2a review, 2026-09-30).
        expect(g).toMatchObject(LAND_CELL);
    });

    it('the finest survey decides: a finer drying band over a mid-scale deep band keeps the land', () => {
        const layers: InshoreLayers = {
            LNDARE: fc(LAND({ _scaleRank: COARSE })),
            DEPARE: fc(depare(5, { _scaleRank: 150 }), depare(-1, { _scaleRank: FINE })),
        };
        expect(probe(build(layers))).toMatchObject(LAND_CELL);
        // …and the same two bands the other way round: the finest never dries.
        const flipped: InshoreLayers = {
            LNDARE: fc(LAND({ _scaleRank: COARSE })),
            DEPARE: fc(depare(-1, { _scaleRank: 150 }), depare(5, { _scaleRank: FINE })),
        };
        expect(probe(build(flipped))).toMatchObject(WATER);
    });

    it('the finest land paint on the cell is the one to beat, whatever the feature order', () => {
        const band = depare(5, { _scaleRank: FINE });
        for (const land of [
            [LAND({ _scaleRank: COARSE }), LAND({ _scaleRank: 250 })],
            [LAND({ _scaleRank: 250 }), LAND({ _scaleRank: COARSE })],
        ]) {
            expect(probe(build({ LNDARE: fc(...land), DEPARE: fc(band) }))).toMatchObject(LAND_CELL);
        }
        // An unranked land claim on the cell poisons the comparison.
        for (const land of [
            [LAND({ _scaleRank: COARSE }), LAND()],
            [LAND(), LAND({ _scaleRank: COARSE })],
        ]) {
            expect(probe(build({ LNDARE: fc(...land), DEPARE: fc(band) }))).toMatchObject(LAND_CELL);
        }
    });

    it('the mark ribbon never reopens land decision 1 upheld, nor deepens conflict water', () => {
        // The synthetic lateral-mark ribbon (InshoreRouter Step 5) restores
        // the chart's DEPARE verdict where land paint "bled" over charted
        // water. Before the decision a band under land paint was a CAUTION
        // conflict the ribbon never touched; the upheld land must not now
        // become the band's 5 m.
        const ribbon = BAND({ _layer: 'FAIRWY', _class: 'synthetic-channel-segment' });
        const equal = probe(
            build({
                LNDARE: fc(LAND({ _scaleRank: FINE })),
                DEPARE: fc(depare(5, { _scaleRank: FINE })),
                FAIRWY: fc(ribbon),
            }),
        );
        expect(equal).toMatchObject({ land: true, deep: false, wetConflict: false });
        const finer = probe(
            build({
                LNDARE: fc(LAND({ _scaleRank: COARSE })),
                DEPARE: fc(depare(5, { _scaleRank: FINE })),
                FAIRWY: fc(ribbon),
            }),
        );
        expect(finer).toMatchObject({ land: false, caution: true, deep: false, wetConflict: true });
    });

    it('OSM-vouched water under land paint is unchanged: clean, not caution', () => {
        const osmRiver = BAND({ natural: 'water', water: 'river', DRVAL1: 10, DRVAL2: 10 });
        const g = probe(build({ LNDARE: fc(LAND({ _scaleRank: FINE })), DEPARE: fc(osmRiver) }));
        expect(g).toMatchObject({ land: false, blocked: false, deep: true, wetConflict: false });
    });
});
