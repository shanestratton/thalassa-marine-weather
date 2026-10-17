import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    saved: vi.fn(),
    official: vi.fn(),
    nearby: vi.fn(),
    details: vi.fn(),
    satellite: vi.fn(() => false),
}));
vi.mock('../services/tides/offlineTideStore', async () => ({
    ...(await vi.importActual('../services/tides/offlineTideStore')),
    listSavedTideTables: mocks.saved,
}));
vi.mock('../services/tides/officialTides', () => ({ fetchOfficialTides: mocks.official }));
vi.mock('../services/tides/stationDetails', () => ({
    fetchNearbyTideStations: mocks.nearby,
    fetchTideStationDetails: mocks.details,
}));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: mocks.satellite }));
import { loadPassageTideSources, passageStationInfo } from '../services/tides/passageTideSources';
import type { TideStationDetails } from '../services/tides/stationDetails';
const T = Date.parse('2026-10-17T08:00:00Z');
const detail = (): TideStationDetails => ({
    station: { id: 's', name: 'Requested', lat: 0, lon: 0, distance: 0 },
    predictionLocation: { lat: 0, lon: 0.01 },
    predictionStationName: 'Actual prediction',
    datum: 'MSL',
    requestedDatum: 'LAT',
    timezone: 'UTC',
    fetchedAtMs: T,
    source: 'WorldTides',
    copyright: 'Synthetic attribution',
    kind: 'prediction',
    wind: null,
    heights: [
        { timeMs: T, heightM: 1 },
        { timeMs: T + 1800000, heightM: 2 },
    ],
    extremes: [{ timeMs: T, type: 'Low', heightM: 1 }],
});
const options = () => ({ signal: new AbortController().signal, assertCurrent: () => {} });
describe('real passage tide source adapters', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.saved.mockResolvedValue([]);
        mocks.satellite.mockReturnValue(false);
        mocks.official.mockResolvedValue(null);
        mocks.nearby.mockResolvedValue([]);
    });
    it('reads aboard references without official, station or paid wind requests', async () => {
        const result = await loadPassageTideSources({ lat: 0, lon: 0 }, T, 'aboard', options());
        expect(result.navigationSeries).toEqual([]);
        expect(mocks.official).not.toHaveBeenCalled();
        expect(mocks.nearby).not.toHaveBeenCalled();
        expect(mocks.details).not.toHaveBeenCalled();
    });
    it('interpolates only original nearby sampled heights while keeping actual MSL, position and unknown original clock', () => {
        const result = passageStationInfo(detail(), { lat: 0, lon: 0 }, T + 900000, T);
        expect(result.heightAtEtaM).toBe(1.5);
        expect(result.datum).toBe('MSL');
        expect(result.datumEpoch).toBeNull();
        expect(result.originalIssueMs).toBeNull();
        expect(result.distanceKm).toBeGreaterThan(1);
        expect(result.note).toContain('navigation permission is unverified');
        expect(
            passageStationInfo({ ...detail(), heights: [] }, { lat: 0, lon: 0 }, T + 900000, T).heightAtEtaM,
        ).toBeNull();
        expect(
            passageStationInfo({ ...detail(), predictionLocation: null }, { lat: 0, lon: 0 }, T + 900000, T)
                .heightAtEtaM,
        ).toBeNull();
        expect(
            passageStationInfo(
                {
                    ...detail(),
                    heights: [
                        { timeMs: T, heightM: 1 },
                        { timeMs: T + 7200000, heightM: 2 },
                    ],
                },
                { lat: 0, lon: 0 },
                T + 900000,
                T,
            ).heightAtEtaM,
        ).toBeNull();
    });
    it('makes only the explicitly chosen official lookup and never upgrades events into any-time heights', async () => {
        mocks.official.mockResolvedValue({
            provider: 'NOAA',
            stationId: 's',
            stationName: 'Official',
            lat: 0,
            lon: 0,
            datumLabel: 'MLLW',
            generatedAt: new Date(T).toISOString(),
            events: [{ time: new Date(T).toISOString(), type: 'Low', heightM: 1 }],
            attribution: 'Official test',
        });
        const result = await loadPassageTideSources({ lat: 0, lon: 0 }, T + 900000, 'official', options());
        expect(result.stations[0]).toMatchObject({
            kind: 'official-events',
            heightAtEtaM: null,
            datum: 'MLLW',
            originalIssueMs: null,
        });
        expect(result.navigationSeries).toEqual([]);
        expect(mocks.nearby).not.toHaveBeenCalled();
    });
    it('bounds nearby station calls at three, disables wind and refuses explicit WAN in Satellite Mode', async () => {
        mocks.nearby.mockResolvedValue(
            Array.from({ length: 8 }, (_, i) => ({
                id: String(i),
                name: 'Station',
                lat: 0,
                lon: i / 100,
                distance: i,
            })),
        );
        mocks.details.mockResolvedValue(detail());
        await loadPassageTideSources({ lat: 0, lon: 0 }, T, 'nearby', options());
        expect(mocks.details).toHaveBeenCalledTimes(3);
        expect(
            mocks.details.mock.calls.every((c) => c[1].includeWind === false && c[1].signal instanceof AbortSignal),
        ).toBe(true);
        mocks.satellite.mockReturnValue(true);
        mocks.nearby.mockClear();
        await expect(loadPassageTideSources({ lat: 0, lon: 0 }, T, 'nearby', options())).rejects.toThrow(
            'Satellite Mode',
        );
        expect(mocks.nearby).not.toHaveBeenCalled();
    });
});
