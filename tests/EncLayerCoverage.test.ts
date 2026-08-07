import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCAL_ENC_PACK_LAYER_NAMES } from '../services/enc/localEncPackImport';

/**
 * Every S-57 class the Pi actually produces must be in the import allowlist.
 *
 * The allowlist deliberately fails CLOSED — an unknown class aborts the whole
 * cell rather than being silently dropped, because a dropped layer could be a
 * dropped hazard. The cost of that choice is that one missing class rejects an
 * entire chart: NAVLNE alone blocked 153 of Shane's cells (2026-08-07).
 *
 * This list is the complete vocabulary observed across all 346 cells on
 * Calypso — surveyed on the Pi rather than sampled, after three rounds of
 * fixing one rejected cell at a time. If the Pi's converter learns a new
 * class, this test is where it should be noticed.
 */
const OBSERVED_ON_PI = [
    'ACHARE',
    'BCNCAR',
    'BCNISD',
    'BCNLAT',
    'BCNSAW',
    'BCNSPP',
    'BOYCAR',
    'BOYISD',
    'BOYLAT',
    'BOYSAW',
    'BOYSPP',
    'CBLARE',
    'COALNE',
    'CTNARE',
    'DEPARE',
    'DEPCNT',
    'DRGARE',
    'DWRTPT',
    'FAIRWY',
    'LIGHTS',
    'LNDARE',
    'MARCUL',
    'M_QUAL',
    'NAVLNE',
    'OBSTRN',
    'PIPARE',
    'RECTRC',
    'RESARE',
    'SBDARE',
    'SEAARE',
    'SLCONS',
    'SOUNDG',
    'UWTROC',
    'WRECKS',
];

describe('ENC import layer coverage', () => {
    it('accepts every class observed across the real chart set', () => {
        expect(OBSERVED_ON_PI.filter((layer) => !LOCAL_ENC_PACK_LAYER_NAMES.has(layer))).toEqual([]);
    });

    it('keeps the IALA buoy and beacon sets symmetric', () => {
        // A missing beacon counterpart is the easy mistake: BOYISD present,
        // BCNISD absent. Both mark an isolated danger.
        for (const kind of ['LAT', 'CAR', 'SPP', 'SAW', 'ISD']) {
            expect(LOCAL_ENC_PACK_LAYER_NAMES.has(`BOY${kind}`)).toBe(true);
            expect(LOCAL_ENC_PACK_LAYER_NAMES.has(`BCN${kind}`)).toBe(true);
        }
    });

    it('still fails closed on a genuinely unknown class', () => {
        // The safety property behind the whole allowlist.
        expect(LOCAL_ENC_PACK_LAYER_NAMES.has('NOTACLASS')).toBe(false);
    });
});

/**
 * Boundary overhang tolerance.
 *
 * The declared-bbox check exists to catch a cell whose geometry belongs
 * somewhere else — a mislabelled or tampered pack. It was set to 1e-6 deg
 * (~10 cm), a floating-point epsilon, which rejected two legitimate S-63
 * charts outright: Nouméa (FR466870) overhung by 4 m and Port Vila
 * (GB501494) by 43 m, both from features sitting on the cell boundary.
 */
describe('declared-bbox edge tolerance', () => {
    const source = readFileSync(join(process.cwd(), 'services/enc/localEncPackImport.ts'), 'utf8');

    it('absorbs a real-world boundary overhang', () => {
        const match = source.match(/const BBOX_EDGE_TOLERANCE_DEG = ([0-9.e-]+);/);
        expect(match).not.toBeNull();
        const toleranceDeg = Number(match![1]);
        // Port Vila's measured 0.00041 deg overhang must fit.
        expect(toleranceDeg).toBeGreaterThan(0.00041);
    });

    it('stays far too tight to admit a mislabelled cell', () => {
        const toleranceDeg = Number(source.match(/const BBOX_EDGE_TOLERANCE_DEG = ([0-9.e-]+);/)![1]);
        // A cell carrying another region's geometry is degrees out, not
        // thousandths. Anything approaching a tenth of a degree (~11 km) would
        // stop being a boundary allowance and start hiding real corruption.
        expect(toleranceDeg).toBeLessThan(0.01);
    });

    it('is absolute, not scaled by cell size', () => {
        // A large cell must not earn a proportionally large allowance.
        expect(source).not.toMatch(/BBOX_EDGE_TOLERANCE_DEG\s*\*\s*\(?\s*bbox/);
    });
});
