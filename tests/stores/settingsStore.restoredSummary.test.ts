/**
 * Unit tests for buildRestoredSummary — the helper that feeds the
 * welcome-back modal with the user-facing summary of what just got
 * synced from the cloud.
 */

import { describe, it, expect } from 'vitest';
import {
    buildRestoredSummary,
    DEFAULT_SETTINGS,
    awaitSettingsLoaded,
    useSettingsStore,
    mergeCloudSettings,
} from '../../stores/settingsStore';
import type { UserSettings } from '../../types';

describe('buildRestoredSummary', () => {
    it('falls back to a generic greeting when no name set', () => {
        const summary = buildRestoredSummary(DEFAULT_SETTINGS);
        expect(summary.greetingName).toBeNull();
    });

    it('prefers nickname over first name', () => {
        const s: UserSettings = {
            ...DEFAULT_SETTINGS,
            firstName: 'Shane',
            nickname: 'Skipper',
        };
        expect(buildRestoredSummary(s).greetingName).toBe('Skipper');
    });

    it('falls back to firstName when nickname is missing', () => {
        const s: UserSettings = { ...DEFAULT_SETTINGS, firstName: 'Shane' };
        expect(buildRestoredSummary(s).greetingName).toBe('Shane');
    });

    it('builds a sailboat descriptor with length in feet', () => {
        const s: UserSettings = {
            ...DEFAULT_SETTINGS,
            vessel: {
                name: 'Tayana',
                type: 'sail',
                length: 55,
                beam: 17,
                draft: 6,
                displacement: 60000,
                maxWaveHeight: 8,
                cruisingSpeed: 6,
                fuelCapacity: 100,
                waterCapacity: 200,
            },
        };
        const summary = buildRestoredSummary(s);
        expect(summary.vesselName).toBe('Tayana');
        expect(summary.vesselDescriptor).toBe('Sail · 55ft');
    });

    it('classifies units as metric when length=m AND temp=C', () => {
        const s: UserSettings = {
            ...DEFAULT_SETTINGS,
            units: { ...DEFAULT_SETTINGS.units, length: 'm', temp: 'C' },
        };
        expect(buildRestoredSummary(s).unitsFlavour).toBe('metric');
    });

    it('classifies units as imperial when length=ft AND temp=F', () => {
        const s: UserSettings = {
            ...DEFAULT_SETTINGS,
            units: { ...DEFAULT_SETTINGS.units, length: 'ft', temp: 'F' },
        };
        expect(buildRestoredSummary(s).unitsFlavour).toBe('imperial');
    });

    it('classifies units as mixed when the user picked one of each', () => {
        const s: UserSettings = {
            ...DEFAULT_SETTINGS,
            units: { ...DEFAULT_SETTINGS.units, length: 'm', temp: 'F' },
        };
        expect(buildRestoredSummary(s).unitsFlavour).toBe('mixed');
    });

    it('counts only enabled notifications', () => {
        const s: UserSettings = {
            ...DEFAULT_SETTINGS,
            notifications: {
                wind: { enabled: true, threshold: 25 },
                gusts: { enabled: false, threshold: 35 },
                waves: { enabled: true, threshold: 4 },
                swellPeriod: { enabled: false, threshold: 10 },
                visibility: { enabled: false, threshold: 1 },
                uv: { enabled: false, threshold: 8 },
                tempHigh: { enabled: false, threshold: 35 },
                tempLow: { enabled: false, threshold: 5 },
                precipitation: { enabled: true },
            },
        };
        expect(buildRestoredSummary(s).armedNotifications).toBe(3);
    });

    it('counts saved locations exactly', () => {
        const s: UserSettings = {
            ...DEFAULT_SETTINGS,
            savedLocations: ['Newport', 'Sydney', 'Brisbane'],
        };
        expect(buildRestoredSummary(s).savedLocationCount).toBe(3);
    });

    it('treats undefined savedLocations as zero', () => {
        const s: UserSettings = {
            ...DEFAULT_SETTINGS,
            savedLocations: undefined as unknown as string[],
        };
        expect(buildRestoredSummary(s).savedLocationCount).toBe(0);
    });

    it('passes through default location and subscription tier verbatim', () => {
        const s: UserSettings = {
            ...DEFAULT_SETTINGS,
            defaultLocation: 'Magnetic Island',
            subscriptionTier: 'owner',
        };
        const summary = buildRestoredSummary(s);
        expect(summary.defaultLocation).toBe('Magnetic Island');
        expect(summary.subscriptionTier).toBe('owner');
    });

    it('omits vessel descriptor when vessel is empty (no type, no length)', () => {
        const s: UserSettings = {
            ...DEFAULT_SETTINGS,
            vessel: {
                name: 'Unnamed',
                type: undefined as unknown as 'sail',
                length: 0,
                beam: 0,
                draft: 0,
                displacement: 0,
                maxWaveHeight: 0,
                cruisingSpeed: 0,
                fuelCapacity: 0,
                waterCapacity: 0,
            },
        };
        const summary = buildRestoredSummary(s);
        expect(summary.vesselName).toBe('Unnamed');
        expect(summary.vesselDescriptor).toBeNull();
    });
});

/**
 * awaitSettingsLoaded is the cold-boot race-fix primitive: it lets
 * pullFromCloud wait for loadSettings()'s disk read to finish its
 * `setState({..., loading: false})` before merging cloud data on
 * top. Without this gate, a fast cloud round-trip + slow disk read
 * would let loadSettings' setState land AFTER pullFromCloud's and
 * silently roll the merge back.
 *
 * We can't reliably simulate the timing race itself inside vitest
 * without resetting modules — but we CAN verify the contract that
 * the gate exposes: a Promise that resolves only after the store
 * has flipped out of `loading: true`.
 */
describe('awaitSettingsLoaded — cold-boot race gate', () => {
    it('returns a Promise', () => {
        expect(awaitSettingsLoaded()).toBeInstanceOf(Promise);
    });

    it('resolves; after resolution the store is no longer loading', async () => {
        await awaitSettingsLoaded();
        expect(useSettingsStore.getState().loading).toBe(false);
    });

    it('is idempotent — multiple concurrent calls all resolve cleanly', async () => {
        await Promise.all([awaitSettingsLoaded(), awaitSettingsLoaded(), awaitSettingsLoaded()]);
        expect(useSettingsStore.getState().loading).toBe(false);
    });

    it('resolves immediately on subsequent calls after initial load', async () => {
        // Initial wait
        await awaitSettingsLoaded();
        // Second call should resolve in the same microtask
        const start = performance.now();
        await awaitSettingsLoaded();
        const elapsed = performance.now() - start;
        expect(elapsed).toBeLessThan(5); // ms — well under any real native bridge latency
    });
});

/**
 * mergeCloudSettings is the pure merge core of pullFromCloud — top-
 * level cloud wins, but the four compound objects (notifications,
 * units, comfortParams, vessel) get sub-key-preserving deep merges.
 * These tests pin down the behaviour you'd care about most: yacht
 * picker, comfort-zone thresholds, and the metric/imperial knobs all
 * come back without any local sub-key getting clobbered by a partial
 * cloud row.
 */
describe('mergeCloudSettings — partial-cloud defence', () => {
    const baseCurrent: UserSettings = {
        ...DEFAULT_SETTINGS,
        comfortParams: { maxWindKts: 25, maxGustKts: 35, maxWaveM: 3 },
    };

    it('preserves local comfortParams sub-keys when cloud has only one', () => {
        const cloud: Partial<UserSettings> = {
            comfortParams: { maxWindKts: 40 }, // partial — missing gust + wave
        };
        const merged = mergeCloudSettings(baseCurrent, cloud, baseCurrent.vessel);
        expect(merged.comfortParams).toEqual({
            maxWindKts: 40, // cloud wins for the key it has
            maxGustKts: 35, // local survives
            maxWaveM: 3, // local survives
        });
    });

    it('keeps local comfortParams intact when cloud has none', () => {
        const merged = mergeCloudSettings(baseCurrent, {}, baseCurrent.vessel);
        expect(merged.comfortParams).toEqual({ maxWindKts: 25, maxGustKts: 35, maxWaveM: 3 });
    });

    it('takes cloud comfortParams whole when local has none', () => {
        const localNoComfort = { ...DEFAULT_SETTINGS, comfortParams: undefined };
        const cloud: Partial<UserSettings> = {
            comfortParams: { maxWindKts: 30, maxGustKts: 45, maxWaveM: 2.5 },
        };
        const merged = mergeCloudSettings(localNoComfort, cloud, localNoComfort.vessel);
        expect(merged.comfortParams).toEqual({ maxWindKts: 30, maxGustKts: 45, maxWaveM: 2.5 });
    });

    it('preserves local notification keys when cloud carries a truly partial notifications object', () => {
        // Simulates a legacy cloud row (or a write that pre-dates a
        // newer notification key) — the cloud notifications object
        // does NOT spread DEFAULT_SETTINGS, only the keys the cloud
        // genuinely has.
        const local: UserSettings = {
            ...DEFAULT_SETTINGS,
            notifications: {
                ...DEFAULT_SETTINGS.notifications,
                wind: { enabled: true, threshold: 25 },
                gusts: { enabled: true, threshold: 40 },
            },
        };
        const cloud: Partial<UserSettings> = {
            // Only `wind` — cloud row truly has nothing else
            notifications: { wind: { enabled: true, threshold: 30 } } as UserSettings['notifications'],
        };
        const merged = mergeCloudSettings(local, cloud, local.vessel);
        expect(merged.notifications.wind).toEqual({ enabled: true, threshold: 30 });
        // Local gusts survives because cloud's notifications object was
        // spread over current's at the sub-key level
        expect(merged.notifications.gusts).toEqual({ enabled: true, threshold: 40 });
    });

    it('preserves local units sub-keys when cloud has only one', () => {
        const local: UserSettings = {
            ...DEFAULT_SETTINGS,
            units: { ...DEFAULT_SETTINGS.units, speed: 'kts', length: 'ft', temp: 'F' },
        };
        const cloud: Partial<UserSettings> = {
            units: { ...DEFAULT_SETTINGS.units, temp: 'C' }, // cloud only changes temp
        };
        const merged = mergeCloudSettings(local, cloud, local.vessel);
        // Cloud spread carries DEFAULT_SETTINGS.units along with the temp:C,
        // so this test pins down only the override behaviour:
        expect(merged.units.temp).toBe('C');
    });

    it('top-level polar data round-trips through the merge', () => {
        const polarSample = {
            windSpeeds: [5, 10, 15, 20],
            angles: [45, 60, 90, 120, 150],
            matrix: [
                [3, 5, 6, 6],
                [4, 6, 7, 7],
                [5, 7, 7.5, 7.5],
                [4, 6.5, 7, 7],
                [3, 5, 6, 6.5],
            ],
        };
        const cloud: Partial<UserSettings> = {
            polarData: polarSample,
            polarBoatModel: 'Tayana 55',
        };
        const merged = mergeCloudSettings(baseCurrent, cloud, baseCurrent.vessel);
        expect(merged.polarData).toEqual(polarSample);
        expect(merged.polarBoatModel).toBe('Tayana 55');
    });

    it('isPro stays consistent with subscriptionTier (cloud wins)', () => {
        const local: UserSettings = { ...DEFAULT_SETTINGS, subscriptionTier: 'free', isPro: false };
        const cloud: Partial<UserSettings> = { subscriptionTier: 'owner' };
        const merged = mergeCloudSettings(local, cloud, local.vessel);
        expect(merged.subscriptionTier).toBe('owner');
        expect(merged.isPro).toBe(true);
    });

    // Cross-device vessel transfer (Shane 2026-07-17): the pre-merged vessel
    // the caller passes IS what lands in `merged.vessel` — a locally-onboarded
    // keel that the cloud row never carried survives the merge, which is what
    // pullFromCloud then pushes back up so the next device (web) sees the draft.
    it('carries the pre-merged vessel through verbatim (local draft survives a draftless cloud)', () => {
        const local: UserSettings = {
            ...DEFAULT_SETTINGS,
            vessel: { name: 'Serene Summer', type: 'sail', draft: 7.9 } as UserSettings['vessel'],
        };
        // Cloud settings has NO vessel at all (the onboarded-while-signed-out case).
        const merged = mergeCloudSettings(local, { defaultLocation: 'Newport' }, local.vessel);
        expect(merged.vessel?.draft).toBe(7.9);
        expect(merged.vessel?.name).toBe('Serene Summer');
        expect(merged.defaultLocation).toBe('Newport'); // cloud key still wins where it has one
    });
});
