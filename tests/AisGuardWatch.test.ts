/**
 * The collision guard must watch whenever it is armed — not only while the
 * chart's AIS layer happens to be drawn.
 *
 * Found in the 2026-08-13 lockdown sweep. The single production call to
 * AisGuardZone.checkFeatures lived inside useAisStreamLayer's mergeAndWrite,
 * behind `if (!map || !enabled) return`, where `enabled` is the AIS LAYER
 * VISIBILITY flag. Tapping Storms or Squall calls setAisVisible(false)
 * (buildTacticalState treats them as mutually exclusive); showing a passage
 * does the same via planningSurface; leaving the chart unmounts the hook
 * entirely. In every case the guard stopped watching while its armed state —
 * which persists on a separate key — kept the shield showing red.
 *
 * A collision-avoidance feature reporting itself ON while watching nothing is
 * worse than one plainly off. These tests exist so it cannot regress quietly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
    guardState: { enabled: true, radiusNm: 2, alerts: [] as unknown[] },
    // Typed args so mock.calls[n][i] is indexable — the call shape IS the
    // assertion in several of these tests.
    checkFeatures: vi.fn(
        (_lat: number, _lon: number, _features: { properties?: { mmsi?: number } }[], _ownMmsi?: number) =>
            [] as unknown[],
    ),
    ownship: { lat: -27.2, lon: 153.1 } as { lat: number; lon: number } | null,
    localFeatures: [] as unknown[],
}));

vi.mock('../services/AisGuardZone', () => ({
    AisGuardZone: {
        getState: () => hoisted.guardState,
        checkFeatures: hoisted.checkFeatures,
    },
}));
vi.mock('../services/AisStore', () => ({
    AisStore: {
        toGeoJSON: () => ({ type: 'FeatureCollection', features: hoisted.localFeatures }),
        subscribe: () => () => {},
    },
}));
vi.mock('../services/ownshipPosition', () => ({ resolveOwnshipPosition: () => hoisted.ownship }));
vi.mock('../services/NmeaStore', () => ({ NmeaStore: { getState: () => ({}) } }));
vi.mock('../stores/LocationStore', () => ({ LocationStore: { getState: () => ({}) } }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ settings: { vessel: { mmsi: '503101240' } } }) },
}));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { runGuardCheck, publishInternetAisFeatures, __resetAisGuardWatchForTests } from '../services/AisGuardWatch';

const target = (mmsi: number) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [153.1, -27.2] },
    properties: { mmsi },
});

beforeEach(() => {
    __resetAisGuardWatchForTests();
    hoisted.guardState = { enabled: true, radiusNm: 2, alerts: [] };
    hoisted.ownship = { lat: -27.2, lon: 153.1 };
    hoisted.localFeatures = [];
    hoisted.checkFeatures.mockClear();
    hoisted.checkFeatures.mockReturnValue([]);
});

describe('AisGuardWatch', () => {
    it('checks receiver targets with NO map and NO AIS layer anywhere', () => {
        // The whole point: nothing here knows a chart exists.
        hoisted.localFeatures = [target(503111222)];
        runGuardCheck();
        expect(hoisted.checkFeatures).toHaveBeenCalledTimes(1);
        const [lat, lon, features] = hoisted.checkFeatures.mock.calls[0];
        expect(lat).toBe(-27.2);
        expect(lon).toBe(153.1);
        expect(features).toHaveLength(1);
    });

    it('does nothing while disarmed', () => {
        hoisted.guardState.enabled = false;
        hoisted.localFeatures = [target(1)];
        expect(runGuardCheck()).toBe(0);
        expect(hoisted.checkFeatures).not.toHaveBeenCalled();
    });

    it('does not alert without a fix — no position is not an empty sea', () => {
        hoisted.ownship = null;
        hoisted.localFeatures = [target(1)];
        expect(runGuardCheck()).toBe(0);
        expect(hoisted.checkFeatures).not.toHaveBeenCalled();
    });

    it('passes ownship MMSI so the boat cannot alarm on its own transponder', () => {
        hoisted.localFeatures = [target(503101240)];
        runGuardCheck();
        expect(hoisted.checkFeatures.mock.calls[0][3]).toBe(503101240);
    });

    it('fires the alert event when a target is inside the ring', () => {
        const alert = { mmsi: 1, name: 'Trawler', distanceNm: 0.4 };
        hoisted.checkFeatures.mockReturnValue([alert]);
        hoisted.localFeatures = [target(1)];
        const seen: unknown[] = [];
        const handler = (e: Event) => seen.push((e as CustomEvent).detail);
        window.addEventListener('ais-guard-alert', handler);
        expect(runGuardCheck()).toBe(1);
        window.removeEventListener('ais-guard-alert', handler);
        expect(seen).toEqual([[alert]]);
    });

    it('merges internet features but lets the receiver win an MMSI collision', () => {
        hoisted.localFeatures = [target(111)];
        publishInternetAisFeatures([target(111), target(222)] as never);
        runGuardCheck();
        const features = hoisted.checkFeatures.mock.calls[0][2];
        expect(features.map((f) => f.properties?.mmsi)).toEqual([111, 222]);
    });

    it('keeps watching receiver targets after the internet feed goes stale', () => {
        // The layer unmounting, or the internet AIS dying — which it has, since
        // aisstream went down on 2026-08-05 — must never stop the guard.
        hoisted.localFeatures = [target(111)];
        publishInternetAisFeatures([target(999)] as never);
        runGuardCheck(Date.now() + 10 * 60_000);
        const features = hoisted.checkFeatures.mock.calls[0][2];
        expect(features.map((f) => f.properties?.mmsi)).toEqual([111]);
    });
});
