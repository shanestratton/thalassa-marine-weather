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
