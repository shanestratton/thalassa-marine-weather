/**
 * Sync settings-mirror seed — the instant warm-boot paint path.
 *
 * The store mirrors settings to localStorage on every write and seeds
 * synchronously from it at module-eval so `loading` starts false and the
 * Glass screen paints on the first frame (instead of waiting on the async
 * Capacitor Preferences load behind a splash). These pin the two
 * load-bearing pure pieces: the shared merge (so the sync seed and the
 * async load can never drift) and the mirror round-trip.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
    DEFAULT_SETTINGS,
    SETTINGS_MIRROR_KEY,
    mergeSettings,
    readSettingsMirrorSync,
    writeSettingsMirror,
} from '../../stores/settingsStore';
import type { UserSettings } from '../../types';

afterEach(() => {
    localStorage.removeItem(SETTINGS_MIRROR_KEY);
});

describe('mergeSettings — sync-seed / async-load parity', () => {
    it('fills missing keys from DEFAULT_SETTINGS', () => {
        const merged = mergeSettings({ firstName: 'Shane' });
        expect(merged.firstName).toBe('Shane');
        expect(merged.heroWidgets).toEqual(DEFAULT_SETTINGS.heroWidgets);
        expect((merged.rowOrder ?? []).length).toBeGreaterThan(0);
        expect(merged.units.waveHeight).toBeDefined();
    });

    it('empty/invalid heroWidgets fall back to defaults (never blank dashboard)', () => {
        expect(mergeSettings({ heroWidgets: [] }).heroWidgets).toEqual(DEFAULT_SETTINGS.heroWidgets);
        expect(mergeSettings({ heroWidgets: 'nope' as unknown as string[] }).heroWidgets).toEqual(
            DEFAULT_SETTINGS.heroWidgets,
        );
    });

    it('legacy isPro:true with no tier migrates to owner', () => {
        const merged = mergeSettings({ isPro: true });
        expect(merged.subscriptionTier).toBe('owner');
        expect(merged.isPro).toBe(true);
    });

    it('isPro:false with no tier migrates to free', () => {
        const merged = mergeSettings({ isPro: false });
        expect(merged.subscriptionTier).toBe('free');
        expect(merged.isPro).toBe(false);
    });

    it('deep-merges units and vessel without dropping unknown sub-keys', () => {
        const merged = mergeSettings({ units: { temp: 'F' }, vessel: { name: 'Tayana', type: 'sail' } });
        expect(merged.units.temp).toBe('F');
        expect(merged.units.speed).toBe(DEFAULT_SETTINGS.units.speed); // preserved
        expect(merged.vessel?.name).toBe('Tayana');
    });

    it('waveHeight back-compat: falls back to legacy length unit then m', () => {
        expect(mergeSettings({ units: { length: 'ft' } }).units.waveHeight).toBe('ft');
        expect(mergeSettings({ units: {} }).units.waveHeight).toBe('m');
    });
});

describe('settings mirror round-trip', () => {
    it('writeSettingsMirror → readSettingsMirrorSync recovers the settings', () => {
        const s: UserSettings = { ...DEFAULT_SETTINGS, firstName: 'Shane', defaultLocation: 'Newport, QLD' };
        writeSettingsMirror(s);
        const read = readSettingsMirrorSync();
        expect(read?.firstName).toBe('Shane');
        expect(read?.defaultLocation).toBe('Newport, QLD');
    });

    it('no mirror → null (first-ever launch keeps the splash path)', () => {
        expect(readSettingsMirrorSync()).toBeNull();
    });

    it('corrupt mirror → null, never throws (falls back to async load)', () => {
        localStorage.setItem(SETTINGS_MIRROR_KEY, '{ not json');
        expect(readSettingsMirrorSync()).toBeNull();
    });

    it('the mirror read is identical to merging the same blob (no drift)', () => {
        const blob = { firstName: 'Shane', units: { temp: 'F' }, heroWidgets: ['wind'] };
        writeSettingsMirror(mergeSettings(blob));
        expect(readSettingsMirrorSync()).toEqual(mergeSettings(blob));
    });
});
