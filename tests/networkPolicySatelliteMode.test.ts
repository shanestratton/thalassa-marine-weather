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
        const kinds = ['grib', 'raster', 'ais-internet', 'offline-download', 'media-upload'] as const;
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
        // Put the standard mock back and clear the registry, or every LATER
        // dynamic import in this file binds to the real store (this bit us:
        // the GRIB test below saw satelliteMode=false and called fetch).
        vi.doMock('../stores/settingsStore', () => ({
            useSettingsStore: { getState: () => ({ settings: settings.value }) },
        }));
        vi.resetModules();
    });

    it('every enforced kind names a real channel, so the UI list cannot drift', () => {
        const valid = new Set(['grib', 'raster', 'ais-internet', 'offline-download', 'media-upload']);
        expect(SATELLITE_MODE_ENFORCED.length).toBeGreaterThan(0);
        for (const entry of SATELLITE_MODE_ENFORCED) {
            expect(valid.has(entry.kind), entry.kind).toBe(true);
            expect(entry.label.trim().length).toBeGreaterThan(0);
        }
    });
});

describe('every heavy fetcher consults the policy (audit item 12)', () => {
    // Source contracts: the Account screen renders SATELLITE_MODE_ENFORCED, so
    // each kind it lists must be enforced by at least the call sites below.
    // A gate that quietly disappears from one of these files is a promise the
    // UI keeps making and the code stops keeping.
    const cases: Array<[string, string, number]> = [
        ['components/dashboard/hero/radarGlassEngine.ts', "satelliteModeBlocks('raster')", 1],
        ['components/map/useSquallMap.ts', "satelliteModeBlocks('raster')", 1],
        ['services/weather/api/rainbowPrecip.ts', "satelliteModeBlocks('raster')", 1],
        ['services/weather/CycloneTrackingService.ts', "satelliteModeBlocks('grib')", 2],
        ['services/weather/WindDataController.ts', "satelliteModeBlocks('grib')", 1],
        ['services/weather/fetchWindGrid.ts', "assertNetworkAllowed('grib'", 1],
        ['services/VesselMetadataService.ts', "satelliteModeBlocks('ais-internet')", 1],
        ['components/map/useAisStreamLayer.ts', "satelliteModeBlocks('ais-internet')", 2],
        ['services/MapOfflineService.ts', "satelliteModeBlocks('offline-download')", 1],
        ['services/DiaryService.ts', "satelliteModeBlocks('media-upload')", 2],
    ];
    for (const [file, needle, count] of cases) {
        it(`${file} gates ${needle}`, () => {
            const src = readFileSync(file, 'utf8');
            expect(src.split(needle).length - 1, `${file} should contain ${needle} ×${count}`).toBe(count);
        });
    }

    it('the diary gates sit on the media primitives, before any byte is sent', () => {
        const src = readFileSync('services/DiaryService.ts', 'utf8');
        for (const fn of ['private async _uploadBlob(', 'private async _uploadVideoBlob(']) {
            const at = src.indexOf(fn);
            expect(at, fn).toBeGreaterThan(0);
            const body = src.slice(
                at,
                src.indexOf('supabase.storage', at) > 0 ? src.indexOf('supabase.storage', at) : at + 1500,
            );
            expect(body, `${fn} must return null under Satellite Mode before uploading`).toContain(
                "if (satelliteModeBlocks('media-upload')) return null;",
            );
        }
    });

    it('the Account screen renders the enforced list and no longer makes the old promise', () => {
        // Strip comments first — the history of the old promise is recorded in
        // a JSX comment, and prose must never trip a source contract.
        const tab = readFileSync('components/settings/AccountTab.tsx', 'utf8')
            .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        expect(tab).toContain('SATELLITE_MODE_ENFORCED.map(');
        expect(tab).not.toContain('~200 KB/day');
        expect(tab).not.toContain('StormGlass only');
    });
});

describe('Satellite Mode stops the GRIB fetch before the network', () => {
    it('fetchWindGridOrNull returns null and never calls fetch', async () => {
        settings.value = { satelliteMode: true };
        const fetchSpy = vi.fn(() => {
            throw new Error('network must not be touched in Satellite Mode');
        });
        vi.stubGlobal('fetch', fetchSpy);
        try {
            const { fetchWindGridOrNull } = await import('../services/weather/fetchWindGrid');
            const buf = await fetchWindGridOrNull({ north: -26, south: -28, east: 154, west: 152 });
            expect(buf).toBeNull();
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
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
