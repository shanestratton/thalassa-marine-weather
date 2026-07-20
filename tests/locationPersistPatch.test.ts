/**
 * locationPersistPatch — a location selection must persist name AND coords
 * as a pair.
 *
 * The bug this locks out: selectLocation persisted only the name, leaving
 * settings.defaultLocationCoords frozen at the onboarding home port. Boot
 * (WeatherOrchestrator.triggerInitialFetch) prefers saved coords over
 * re-geocoding the name, so after ANY restart — crash, jetsam, plain iOS
 * eviction — the app fetched the newly picked name against the OLD home-port
 * coordinates and "came back to Newport".
 */
import { describe, expect, it } from 'vitest';
import { locationPersistPatch } from '../context/WeatherContext';

const NEWPORT = { lat: -27.06, lon: 153.1 };
const AIRLIE = { lat: -20.267, lon: 148.718 };

describe('locationPersistPatch', () => {
    it('persists name and coords together for a new pick', () => {
        const prev = { defaultLocation: 'Newport, QLD', defaultLocationCoords: NEWPORT };
        expect(locationPersistPatch(prev, 'Airlie Beach, QLD', AIRLIE)).toEqual({
            defaultLocation: 'Airlie Beach, QLD',
            defaultLocationCoords: AIRLIE,
        });
    });

    it('clears saved coords on a name-only selection so boot resolves the name', () => {
        const prev = { defaultLocation: 'Newport, QLD', defaultLocationCoords: NEWPORT };
        expect(locationPersistPatch(prev, 'Airlie Beach, QLD')).toEqual({
            defaultLocation: 'Airlie Beach, QLD',
            defaultLocationCoords: undefined,
        });
    });

    it('writes when the name is unchanged but the coords moved (two picks, same suburb)', () => {
        const prev = { defaultLocation: 'Airlie Beach, QLD', defaultLocationCoords: AIRLIE };
        const nearby = { lat: -20.28, lon: 148.75 };
        expect(locationPersistPatch(prev, 'Airlie Beach, QLD', nearby)).toEqual({
            defaultLocation: 'Airlie Beach, QLD',
            defaultLocationCoords: nearby,
        });
    });

    it('no-ops when nothing changed', () => {
        const prev = { defaultLocation: 'Airlie Beach, QLD', defaultLocationCoords: AIRLIE };
        expect(locationPersistPatch(prev, 'Airlie Beach, QLD', { ...AIRLIE })).toBeNull();
        expect(locationPersistPatch(prev, '')).toBeNull();
    });

    it('re-pairs coords even when only coords were stale (fresh onboarding state)', () => {
        // Onboarding-before-fix state: name matches what the user picked but
        // coords still point at the home port.
        const prev = { defaultLocation: 'Airlie Beach, QLD', defaultLocationCoords: NEWPORT };
        expect(locationPersistPatch(prev, 'Airlie Beach, QLD', AIRLIE)).toEqual({
            defaultLocation: 'Airlie Beach, QLD',
            defaultLocationCoords: AIRLIE,
        });
    });

    it('handles a first-run state with nothing persisted', () => {
        expect(locationPersistPatch({}, 'Airlie Beach, QLD', AIRLIE)).toEqual({
            defaultLocation: 'Airlie Beach, QLD',
            defaultLocationCoords: AIRLIE,
        });
    });
});
