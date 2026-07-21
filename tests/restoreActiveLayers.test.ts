/**
 * restoreActiveLayers — which weather layers the chart page opens on.
 *
 * The animated wind field is the chart page's signature look. It went
 * missing not because anything was deleted (the renderer is byte-identical
 * to March) but because the restore stripped 'wind' on EVERY launch: turning
 * it on never survived to the next open.
 *
 * The subtle part these lock down is the three-way distinction between an
 * ABSENT preference (first run → wind), an EMPTY one (user deliberately
 * turned everything off → stay off), and a stored selection. The persistence
 * side used to delete the key on all-off, which collapsed the first two into
 * one and would make every all-off bounce back to wind.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_LAYERS, restoreActiveLayers } from '../components/map/useWeatherLayers';

describe('restoreActiveLayers', () => {
    it('opens on wind when nothing is stored (first run)', () => {
        expect([...restoreActiveLayers(null)]).toEqual(['wind']);
        expect(DEFAULT_LAYERS).toContain('wind');
    });

    it('HONOURS a deliberate all-off — "[]" must not bounce back to wind', () => {
        expect([...restoreActiveLayers('[]')]).toEqual([]);
    });

    it('restores a stored selection as-is', () => {
        expect([...restoreActiveLayers('["wind","rain"]')].sort()).toEqual(['rain', 'wind']);
    });

    it('keeps wind when stored — the whole point of the fix', () => {
        // The old code filtered 'wind' and 'velocity' out here, so the layer
        // could never survive a relaunch.
        expect([...restoreActiveLayers('["wind"]')]).toEqual(['wind']);
        expect([...restoreActiveLayers('["velocity"]')]).toEqual(['velocity']);
    });

    it('still drops parked layers, which have no picker to turn them off', () => {
        const got = [...restoreActiveLayers('["wind","waves","seaice","mld"]')];
        expect(got).toEqual(['wind']);
    });

    it('drops parked layers even when that empties the set — no default rescue', () => {
        // A stored preference existed, so this is not a first run; the user
        // should land on a clean chart, not have wind conjured up.
        expect([...restoreActiveLayers('["waves"]')]).toEqual([]);
    });

    it('falls back to the default on junk rather than throwing', () => {
        expect([...restoreActiveLayers('not json')]).toEqual(['wind']);
        expect([...restoreActiveLayers('{"nope":true}')]).toEqual(['wind']);
        expect([...restoreActiveLayers('null')]).toEqual(['wind']);
    });
});
