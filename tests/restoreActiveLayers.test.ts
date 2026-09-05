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

import type { WeatherLayer } from '../components/map/mapConstants';
import { DEFAULT_LAYERS, enforceCmemsMarineExclusivity, restoreActiveLayers } from '../components/map/useWeatherLayers';

describe('restoreActiveLayers', () => {
    it('opens on the default when nothing is stored (first run)', () => {
        // The default became EMPTY on 2026-09-05 — the chart opens as a chart
        // in Inspect mode rather than under a wind field nobody asked for.
        // Asserted against DEFAULT_LAYERS, not a literal, so the NEXT change of
        // mind moves one constant instead of chasing hardcoded strings.
        expect([...restoreActiveLayers(null)]).toEqual([...DEFAULT_LAYERS]);
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

    it('drops an unparked CMEMS product when its exact build flag is false', () => {
        const exactAvailability = (layer: WeatherLayer) => layer !== 'currents';
        expect([...restoreActiveLayers('["wind","currents"]', exactAvailability)]).toEqual(['wind']);
    });

    it('allows only one decoded CMEMS marine product to be owned at a time', () => {
        expect([...restoreActiveLayers('["wind","currents","sst","chl"]', () => true)].sort()).toEqual(['chl', 'wind']);
        expect(
            [
                ...enforceCmemsMarineExclusivity(new Set<WeatherLayer>(['wind', 'currents', 'sst', 'chl']), 'currents'),
            ].sort(),
        ).toEqual(['currents', 'wind']);
    });

    it('falls back to the default on junk rather than throwing', () => {
        expect([...restoreActiveLayers('not json')]).toEqual([...DEFAULT_LAYERS]);
        expect([...restoreActiveLayers('{"nope":true}')]).toEqual([...DEFAULT_LAYERS]);
        expect([...restoreActiveLayers('null')]).toEqual([...DEFAULT_LAYERS]);
    });

    it('still tells an ABSENT preference from a deliberate all-off', () => {
        // Both answer [] while the default is empty, so the distinction is
        // invisible in the result — but it is the code path that matters, and
        // it has to survive the default changing back one day.
        expect([...restoreActiveLayers(null)]).toEqual([...DEFAULT_LAYERS]);
        expect([...restoreActiveLayers('[]')]).toEqual([]);
        // A stored selection is still honoured over the default either way.
        expect([...restoreActiveLayers('["rain"]')]).toEqual(['rain']);
    });
});
