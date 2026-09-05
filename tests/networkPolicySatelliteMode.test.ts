/**
 * Satellite Mode is one policy every heavy fetcher consults.
 *
 * The Account screen promises "~200 KB/day, weather only". Three behaviours
 * honoured it; the heavy automatic fetchers (GRIB, radar, internet AIS, bulk
 * offline) did not (audit item 12). networkPolicy.ts is the single source of
 * truth, and this pins the contract its call sites depend on — plus that my two
 * gates (the AIS live poll, the wind overlay's Open-Meteo branch, neither of
 * which the caller-side gates cover) actually consult it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const settings = vi.hoisted(() => ({ value: { satelliteMode: false } as { satelliteMode?: boolean } }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ settings: settings.value }) },
}));

import {
    satelliteModeActive,
    satelliteModeBlocks,
    assertNetworkAllowed,
    NetworkPolicyBlockedError,
    SATELLITE_MODE_ENFORCED,
} from '../services/networkPolicy';

beforeEach(() => {
    settings.value = { satelliteMode: false };
});
afterEach(() => vi.clearAllMocks());

describe('networkPolicy', () => {
    it('is off by default and reads the live setting', () => {
        expect(satelliteModeActive()).toBe(false);
        settings.value = { satelliteMode: true };
        expect(satelliteModeActive()).toBe(true);
    });

    it('blocks every discretionary kind when on, none when off', () => {
        const kinds = ['grib', 'raster', 'ais-internet', 'offline-download'] as const;
        for (const k of kinds) expect(satelliteModeBlocks(k)).toBe(false);
        settings.value = { satelliteMode: true };
        for (const k of kinds) expect(satelliteModeBlocks(k)).toBe(true);
    });

    it('assertNetworkAllowed throws a typed error only when blocked', () => {
        expect(() => assertNetworkAllowed('grib', 'wind grid')).not.toThrow();
        settings.value = { satelliteMode: true };
        expect(() => assertNetworkAllowed('grib', 'wind grid')).toThrow(NetworkPolicyBlockedError);
        try {
            assertNetworkAllowed('grib', 'wind grid');
        } catch (e) {
            expect(e).toBeInstanceOf(NetworkPolicyBlockedError);
            expect((e as NetworkPolicyBlockedError).kind).toBe('grib');
        }
    });

    it('fails OPEN if the store cannot be read — a coastal user is never stranded', async () => {
        vi.resetModules();
        vi.doMock('../stores/settingsStore', () => ({
            useSettingsStore: {
                getState: () => {
                    throw new Error('store unavailable');
                },
            },
        }));
        const mod = await import('../services/networkPolicy');
        expect(mod.satelliteModeActive()).toBe(false);
        vi.doUnmock('../stores/settingsStore');
    });

    it('every enforced kind names a real channel, so the UI list cannot drift', () => {
        const valid = new Set(['grib', 'raster', 'ais-internet', 'offline-download']);
        expect(SATELLITE_MODE_ENFORCED.length).toBeGreaterThan(0);
        for (const entry of SATELLITE_MODE_ENFORCED) {
            expect(valid.has(entry.kind), entry.kind).toBe(true);
            expect(entry.label.trim().length).toBeGreaterThan(0);
        }
    });
});

describe('the two gates I added consult the policy', () => {
    it('the AIS live poll and ownship floor both check ais-internet', () => {
        const src = readFileSync('components/map/useAisStreamLayer.ts', 'utf8');
        expect((src.match(/satelliteModeBlocks\('ais-internet'\)/g) ?? []).length).toBe(2);
        // Local NMEA still renders — the gate returns after mergeAndWrite, not before.
        const at = src.indexOf("satelliteModeBlocks('ais-internet')");
        expect(src.slice(at, at + 200)).toContain('mergeAndWrite()');
    });

    it('the wind OVERLAY gates on grib, and the passage planner is left alone', () => {
        const overlay = readFileSync('services/weather/WindDataController.ts', 'utf8');
        expect(overlay).toContain("satelliteModeBlocks('grib')");
        // The planner fetches wind directly through fetchWindGrid — which throws
        // NetworkPolicyBlockedError and lets the caller degrade, NOT this
        // overlay gate. Confirm the overlay gate is the only satellite check here.
        expect(overlay).not.toContain('assertNetworkAllowed');
    });
});
