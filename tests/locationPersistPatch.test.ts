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
import { isShowingAnotherPlace, locationPersistPatch } from '../context/WeatherContext';

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

/**
 * The Glass header reads `weatherData.locationName`, NOT the name the punter
 * just tapped — so while a fetch is in flight the previous location's report
 * keeps the header. That read as 4-5 seconds of nothing happening, and had
 * people pressing buttons again (Shane 2026-07-22). Sources return in
 * 0.4-2.7s, so this was never the network.
 */
describe('isShowingAnotherPlace', () => {
    it('is false on a cold start — nothing on screen to contradict', () => {
        expect(isShowingAnotherPlace(undefined, 'Airlie Beach, QLD')).toBe(false);
        expect(isShowingAnotherPlace(null, 'Airlie Beach, QLD')).toBe(false);
        expect(isShowingAnotherPlace('', 'Airlie Beach, QLD')).toBe(false);
    });

    it('is TRUE when the report on screen belongs elsewhere — swap immediately', () => {
        expect(isShowingAnotherPlace('Newport, QLD', 'Airlie Beach, QLD')).toBe(true);
    });

    it('is false for a refresh of the SAME place — no needless blank', () => {
        expect(isShowingAnotherPlace('Newport, QLD', 'Newport, QLD')).toBe(false);
    });

    it('ignores case and padding — one place, three spellings across the app', () => {
        // A favourite, a geocode and a cache key can disagree on casing.
        expect(isShowingAnotherPlace('newport, qld', 'Newport, QLD')).toBe(false);
        expect(isShowingAnotherPlace('  Newport, QLD  ', 'Newport, QLD')).toBe(false);
    });
});
