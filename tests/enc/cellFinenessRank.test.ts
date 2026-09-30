/**
 * Survey fineness for owner decision 1 — round 2 (2026-09-30).
 *
 * Decision 1: a FINER never-drying band over a coarser chart's land paint is
 * shallow water; an equal or coarser band never beats land paint. The rank the
 * router, the lead overlay and the land audit compare used to be the cell's
 * bbox area, so two cells compiled at the same scale compared finer and
 * coarser on any one-unit bbox difference, and a degenerate bbox read 0 — a
 * real rank — instead of unknown.
 *
 * The rank now comes from what the cell says about itself: its compilation
 * scale (DSPM CSCL — the SENC header's native scale the extractor writes on
 * every blob; the Pi's ogr2ogr path reads DSPM_CSCL), else the usage band in
 * its S-57 name (AU5… → 5), else unknown — and unknown never beats land.
 */
import type { Feature, FeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
    cellFinenessRank,
    finerBandBeatsLand,
    stampScaleRank,
    usageBandOfName,
    usageBandOfScale,
} from '../../services/enc/scaleShadow';
import { buildNavGrid } from '../../services/engine/navGrid';
import { auditUnvouchedHardLand } from '../../services/engine/safetyAudit';
import { CAUTION } from '../../services/engine/constants';
import { navLinesOnWater } from '../../services/routing/leadLandClip';

describe('cellFinenessRank — the cell says its scale, or it is unknown', () => {
    it('reads the usage band from an S-57 dataset name, never from an o-charts identifier', () => {
        expect(usageBandOfName('AU5GA22M')).toBe(5);
        expect(usageBandOfName('US4GA22M')).toBe(4);
        expect(usageBandOfName('OC-61-10ENB5')).toBeNull();
        expect(usageBandOfName('AU0ABCDE')).toBeNull();
        expect(usageBandOfName('AU7ABCDE')).toBeNull();
        expect(usageBandOfName(undefined)).toBeNull();
    });

    it('puts a compilation scale in its IHO usage band', () => {
        expect(usageBandOfScale(3_500_000)).toBe(1);
        expect(usageBandOfScale(700_000)).toBe(2);
        expect(usageBandOfScale(150_000)).toBe(3);
        expect(usageBandOfScale(50_000)).toBe(4);
        expect(usageBandOfScale(12_000)).toBe(5);
        expect(usageBandOfScale(2_500)).toBe(6);
    });

    it('two cells compiled at the same scale rank EQUAL, whatever their extents', () => {
        expect(cellFinenessRank({ nativeScale: 50_000 })).toBe(cellFinenessRank({ nativeScale: 50_000 }));
        expect(
            finerBandBeatsLand(cellFinenessRank({ nativeScale: 50_000 }), cellFinenessRank({ nativeScale: 50_000 })),
        ).toBe(false);
    });

    it('a finer compilation scale beats a coarser one, within a band and across bands', () => {
        const r = (s: number) => cellFinenessRank({ nativeScale: s });
        expect(finerBandBeatsLand(r(25_000), r(50_000))).toBe(true); // both approach
        expect(finerBandBeatsLand(r(12_000), r(90_000))).toBe(true);
        expect(finerBandBeatsLand(r(50_000), r(25_000))).toBe(false);
    });

    it('two siblings of one usage band known by name alone never beat each other', () => {
        const a = cellFinenessRank({ sourceCellId: 'AU4GA22M' });
        const b = cellFinenessRank({ cellId: 'AU4HB11K' });
        expect(a).not.toBeNull();
        expect(finerBandBeatsLand(a, b)).toBe(false);
        expect(finerBandBeatsLand(b, a)).toBe(false);
    });

    it('a band known by name alone and one known by scale, in the same usage band, never beat each other', () => {
        const byName = cellFinenessRank({ cellId: 'AU4GA22M' });
        const byScale = cellFinenessRank({ nativeScale: 25_000 }); // approach, band 4
        expect(finerBandBeatsLand(byScale, byName)).toBe(false);
        expect(finerBandBeatsLand(byName, byScale)).toBe(false);
    });

    it('a finer usage band beats a coarser one however each is known', () => {
        expect(
            finerBandBeatsLand(cellFinenessRank({ cellId: 'AU5GA22M' }), cellFinenessRank({ nativeScale: 150_000 })),
        ).toBe(true);
        expect(
            finerBandBeatsLand(cellFinenessRank({ nativeScale: 12_000 }), cellFinenessRank({ cellId: 'AU3GA22M' })),
        ).toBe(true);
    });

    it('a cell that says nothing — or nonsense — is unknown, and unknown never beats land', () => {
        expect(cellFinenessRank({ cellId: 'OC-61-10ENB5' })).toBeNull();
        expect(cellFinenessRank({ nativeScale: 0 })).toBeNull();
        expect(cellFinenessRank({ nativeScale: -5 })).toBeNull();
        expect(cellFinenessRank({ nativeScale: Number.NaN })).toBeNull();
        expect(cellFinenessRank({})).toBeNull();
        expect(finerBandBeatsLand(null, cellFinenessRank({ nativeScale: 3_500_000 }))).toBe(false);
        expect(finerBandBeatsLand(cellFinenessRank({ nativeScale: 12_000 }), null)).toBe(false);
    });

    it('stamping a cell that says nothing leaves its features unranked, removing any earlier stamp', () => {
        const f: Feature = {
            type: 'Feature',
            properties: { _scaleRank: 42 },
            geometry: { type: 'Point', coordinates: [0, 0] },
        };
        stampScaleRank([f], { cellId: 'OC-61-10ENB5' });
        expect(f.properties?._scaleRank).toBeUndefined();
        stampScaleRank([f], { nativeScale: 22_000 });
        expect(f.properties?._scaleRank).toBe(cellFinenessRank({ nativeScale: 22_000 }));
    });
});

// ── The grid, the lead land clip and the audit decide it the same way ──

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
const BBOX: [number, number, number, number] = [152.49, -27.92, 152.53, -27.88];

/**
 * Two sibling cells of one usage band, merged the router's way: land paint
 * from one (a SMALLER cell — the old bbox rank called it finer), a 3 m band
 * from the other (a LARGER cell). Same band, so the land paint stands.
 */
function siblings(landCell: { cellId: string }, bandCell: { cellId: string }) {
    const land = [rect(152.5, -27.91, 152.52, -27.89, { acronym: 'LNDARE' })];
    const band = [rect(152.498, -27.912, 152.522, -27.888, { acronym: 'DEPARE', DRVAL1: 3, DRVAL2: 5 })];
    stampScaleRank(land, landCell);
    stampScaleRank(band, bandCell);
    return { LNDARE: fc(...land), DEPARE: fc(...band) };
}
const lead = (): Feature => ({
    type: 'Feature',
    properties: { acronym: 'NAVLNE', CATNAV: 3 },
    geometry: {
        type: 'LineString',
        coordinates: [
            [152.505, -27.9],
            [152.515, -27.9],
        ],
    },
});
function gridAt(layers: ReturnType<typeof siblings>) {
    const g = buildNavGrid(layers, BBOX, 50, 2.4, 0.5, 60);
    const x = Math.floor((152.51 - g.minLon) / g.dLon);
    const y = Math.floor((-27.9 - g.minLat) / g.dLat);
    const i = y * g.width + x;
    return { land: g.landBlocked?.[i] === 1, caution: g.cells[i] === CAUTION, wetConflict: g.wetConflict?.[i] === 1 };
}

describe('decision 1 across the grid, the lead land clip and the audit (one rank, one rule)', () => {
    it('same-band siblings: the land paint stands everywhere', () => {
        const layers = siblings({ cellId: 'AU4AAA11' }, { cellId: 'AU4BBB22' });
        expect(gridAt(layers)).toMatchObject({ land: true, wetConflict: false });
        expect(navLinesOnWater([lead()], layers)).toHaveLength(0);
        const audit = auditUnvouchedHardLand(layers, [
            [152.505, -27.9],
            [152.515, -27.9],
        ]);
        expect(audit.maxRunM).toBeGreaterThan(900);
    });

    it('a finer usage band under coarser land paint: shallow water everywhere (caution, never land)', () => {
        const layers = siblings({ cellId: 'AU3AAA11' }, { cellId: 'AU5BBB22' });
        expect(gridAt(layers)).toMatchObject({ land: false, caution: true, wetConflict: true });
        expect(navLinesOnWater([lead()], layers)).toHaveLength(1);
        const audit = auditUnvouchedHardLand(layers, [
            [152.505, -27.9],
            [152.515, -27.9],
        ]);
        expect(audit.maxRunM).toBe(0);
    });

    it('cells that do not say their scale: the land paint stands everywhere', () => {
        const layers = siblings({ cellId: 'OC-61-AAAA' }, { cellId: 'OC-61-BBBB' });
        expect(gridAt(layers)).toMatchObject({ land: true, wetConflict: false });
        expect(navLinesOnWater([lead()], layers)).toHaveLength(0);
    });
});
