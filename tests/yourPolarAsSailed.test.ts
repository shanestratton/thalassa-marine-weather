/**
 * The Polars page shows and edits the figures routes sail on (build 131,
 * package 130-B6, was 126-B6b; polars-02, polars-07).
 *
 * A yacht-database table is a generated SHAPE, ~45% slow raw (a 38 ft
 * cruiser makes 3.5 kn on a beam reach in 15 kn), and routes scale it to her
 * cruising speed (services/routingPolar). The page showed and edited the raw
 * table, and one changed cell saved the whole raw table as her own figures —
 * sailed as given — so every route went ~45% slow. yourPolarAsSailed gives
 * the page the scaled figures, the ones routes sail. Fictional boat.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../services/nativeStorage', () => ({
    loadLargeData: vi.fn(async () => null),
    saveLargeData: vi.fn(async () => undefined),
}));

import {
    resolveRoutingPolarFrom,
    routingSpeedModel,
    yourPolarAsSailed,
    type RoutingPolarSettings,
} from '../services/routingPolar';
import { POLAR_DATABASE } from '../data/polarDatabase';
import { passageSpeed, polarReferenceKts } from '../services/passagePlan';
import { createPolarSpeedLookup } from '../services/isochrone/polar';
import type { PolarData, VesselProfile } from '../types';

const SLOOP: VesselProfile = {
    name: 'Fair Wind',
    type: 'sail',
    length: 38,
    beam: 12.8,
    draft: 6.2,
    displacement: 15000,
    maxWaveHeight: 10,
    cruisingSpeed: 6.5,
};

const OCEANIS = POLAR_DATABASE.find((entry) => entry.model === 'Beneteau Oceanis 38.1')!;
const DATABASE: RoutingPolarSettings = {
    polarData: OCEANIS.polar,
    polarBoatModel: OCEANIS.model,
    polarSource_type: 'database',
};

const resolve = (settings: RoutingPolarSettings, vessel: VesselProfile = SLOOP) =>
    resolveRoutingPolarFrom({ settings, vessel, learned: null });

/** The table with one cell changed, as the Manual tab saves it. */
const withCell = (p: PolarData, twa: number, tws: number, kts: number): PolarData => {
    const a = p.angles.indexOf(twa);
    const w = p.windSpeeds.indexOf(tws);
    return { ...p, matrix: p.matrix.map((row, ai) => row.map((v, wi) => (ai === a && wi === w ? kts : v))) };
};

/** A cell of a table by its angle and wind speed. */
const cell = (p: PolarData, twa: number, tws: number) => p.matrix[p.angles.indexOf(twa)][p.windSpeeds.indexOf(tws)];

describe('yourPolarAsSailed: the Polars page shows the figures routes sail on (130-B6)', () => {
    it('a yacht-database table is shown scaled to her cruising speed: each figure the routed one, to 0.01 kn', () => {
        const shown = yourPolarAsSailed(OCEANIS.polar, 'database', SLOOP);
        expect(shown.scaledToKts).toBe(6.5);
        // Its own rows and columns: the Manual tab's grid is unchanged.
        expect(shown.polar.windSpeeds).toEqual(OCEANIS.polar.windSpeeds);
        expect(shown.polar.angles).toEqual(OCEANIS.polar.angles);
        const routed = resolve(DATABASE);
        expect(routed.source).toBe('database-scaled');
        for (const twa of OCEANIS.polar.angles) {
            for (const tws of OCEANIS.polar.windSpeeds) {
                const shownKts = cell(shown.polar, twa, tws);
                expect(Math.abs(shownKts - cell(routed.polar, twa, tws)), `${twa}° / ${tws} kn`).toBeLessThanOrEqual(
                    0.005 + 1e-9,
                );
                expect(Math.round(shownKts * 100) / 100).toBe(shownKts);
            }
        }
        // Raw it was 3.5 kn on a beam reach in 15 kn; shown as routes sail it, over 6.
        expect(cell(OCEANIS.polar, 90, 15)).toBeCloseTo(3.5, 1);
        expect(cell(shown.polar, 90, 15)).toBeGreaterThan(6);
    });

    it('documents the bug: one cell changed in the RAW table made every route ~45% slow', () => {
        const before = resolve(DATABASE);
        const rawEdit = resolve({
            ...DATABASE,
            polarData: withCell(OCEANIS.polar, 45, 10, 3.0),
            polarSource_type: 'manual',
        });
        expect(rawEdit.source).toBe('manual');
        expect(polarReferenceKts(rawEdit.polar) / polarReferenceKts(before.polar)).toBeLessThan(0.6);
    });

    it('one cell changed in the SCALED table changes that cell only: every other figure routes as before', () => {
        const shown = yourPolarAsSailed(OCEANIS.polar, 'database', SLOOP).polar;
        const before = resolve(DATABASE);
        const after = resolve({ ...DATABASE, polarData: withCell(shown, 45, 10, 5.2), polarSource_type: 'manual' });
        expect(after.source).toBe('manual');
        expect(after.label).toBe('Beneteau Oceanis 38.1 (your own figures)');
        // The same rows (her no-go zone included) and columns.
        expect(after.polar.angles).toEqual(before.polar.angles);
        expect(after.polar.windSpeeds).toEqual(before.polar.windSpeeds);
        for (const twa of after.polar.angles) {
            for (const tws of after.polar.windSpeeds) {
                const kts = cell(after.polar, twa, tws);
                if (twa === 45 && tws === 10) expect(kts).toBe(5.2);
                else expect(Math.abs(kts - cell(before.polar, twa, tws)), `${twa}° / ${tws} kn`).toBeLessThan(0.0051);
            }
        }
        // Her fair-reaching speed is still her cruising speed, not ~45% under it.
        expect(polarReferenceKts(after.polar)).toBeCloseTo(6.5, 1);
    });

    it("the passage HUD and Plan Your Day sail the edited polar too: the routers' figure, as given", () => {
        const shown = yourPolarAsSailed(OCEANIS.polar, 'database', SLOOP).polar;
        const after = resolve({ ...DATABASE, polarData: withCell(shown, 90, 15, 6.9), polarSource_type: 'manual' });
        const model = routingSpeedModel(after, { mode: 'polar', cruiseKts: 6.5, isSail: true, closeHauledDeg: 45 });
        expect(model.polarKind).toBe('figures');
        // Wind from the beam of a northbound course.
        expect(passageSpeed(model, 15, 90, 0).kts).toBeCloseTo(createPolarSpeedLookup(after.polar, 15)(90), 9);
        expect(passageSpeed(model, 15, 90, 0).kts).toBeCloseTo(6.9, 9);
    });

    it('her own figures — imported or typed in — are shown as stored, never scaled', () => {
        for (const kind of ['file_import', 'manual', undefined] as const) {
            const shown = yourPolarAsSailed(OCEANIS.polar, kind, SLOOP);
            expect(shown.polar).toBe(OCEANIS.polar);
            expect(shown.scaledToKts).toBeNull();
        }
    });

    it('a database table routes cannot use is shown as stored (the top line says routes sail the generic polar)', () => {
        const tooFast = { ...SLOOP, cruisingSpeed: 30 };
        const shown = yourPolarAsSailed(OCEANIS.polar, 'database', tooFast);
        expect(shown.polar).toBe(OCEANIS.polar);
        expect(shown.scaledToKts).toBeNull();
        expect(resolve(DATABASE, tooFast).label).toBe(
            'Generic cruising polar (your yacht database polar could not be used)',
        );
    });

    it('a boat that is not a sailing boat is shown her table as stored: routes do not sail it', () => {
        const launch: VesselProfile = { ...SLOOP, type: 'power', cruisingSpeed: 9 };
        expect(yourPolarAsSailed(OCEANIS.polar, 'database', launch).polar).toBe(OCEANIS.polar);
        expect(resolve(DATABASE, launch).source).toBe('default');
    });

    it('with no vessel profile it scales as routes do, for the default boat (6 kn)', () => {
        const shown = yourPolarAsSailed(OCEANIS.polar, 'database', null);
        expect(shown.scaledToKts).toBe(6);
        expect(polarReferenceKts(shown.polar)).toBeCloseTo(6, 1);
    });

    it('her cruising speed on "auto" (a stored 0): sqrt(LOA) × 1.2, as routes scale it', () => {
        const auto = { ...SLOOP, cruisingSpeed: 0 };
        const shown = yourPolarAsSailed(OCEANIS.polar, 'database', auto);
        expect(shown.scaledToKts).toBeCloseTo(Math.sqrt(38) * 1.2, 9);
        expect(resolve(DATABASE, auto).label).toBe('Beneteau Oceanis 38.1 (shape scaled to 7.4 kn)');
    });
});
