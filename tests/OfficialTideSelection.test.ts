import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ official: vi.fn(), world: vi.fn(), cached: vi.fn(), cacheSet: vi.fn() }));
vi.mock('../services/tides/officialTides', () => ({ fetchOfficialTides: mocks.official }));
vi.mock('../services/weather/api/worldtides', () => ({ fetchWorldTides: mocks.world }));
vi.mock('../services/weather/apiCache', () => ({ apiCacheGet: mocks.cached, apiCacheSet: mocks.cacheSet }));
import { fetchRealTides, fetchTidesForPosition } from '../services/weather/api/tides';

beforeEach(() => {
    vi.clearAllMocks();
    mocks.cached.mockReturnValue(null);
    mocks.official.mockResolvedValue(null);
});
describe('official display source selection', () => {
    it('keeps official extrema and their provenance together ahead of a WorldTides cache', async () => {
        mocks.cached.mockReturnValue({ tides: [{ height: 99 }] });
        mocks.official.mockResolvedValue({
            provider: 'NOAA',
            stationId: '8575512',
            stationName: 'Annapolis',
            datumId: 'noaa:8575512:MLLW',
            datumLabel: 'MLLW',
            rawDatum: 'MLLW',
            sourceUrl: 'https://tidesandcurrents.noaa.gov/source',
            licenceUrl: 'https://tidesandcurrents.noaa.gov/disclaimers.html',
            attribution: 'NOAA CO-OPS',
            generatedAt: '2026-10-16T00:00:00Z',
            expiresAt: '2026-10-17T00:00:00Z',
            events: [
                { time: '2026-10-16T00:00:00Z', type: 'Low', heightM: 0.2 },
                { time: '2026-10-16T06:00:00Z', type: 'High', heightM: 0.8 },
            ],
        });
        const result = await fetchTidesForPosition(38.98, -76.48);
        expect(result?.tides.map((t) => t.height)).toEqual([0.2, 0.8]);
        expect(result?.tideGUIDetails).toMatchObject({ source: 'official', provider: 'NOAA', datumLabel: 'MLLW' });
        expect(mocks.world).not.toHaveBeenCalled();
        expect(mocks.cacheSet).not.toHaveBeenCalled(); // Never put official capability into the long-lived WT cache.
    });
    it('uses WorldTides and its own datum when the official publisher is unavailable', async () => {
        mocks.world.mockResolvedValue({
            extremes: [{ date: '2026-10-16T00:00:00Z', type: 'High', height: 1.4 }],
            station: { name: 'World station' },
            responseDatum: 'LAT',
        });
        const result = await fetchRealTides(1, 2);
        expect(result.guiDetails).toMatchObject({
            source: 'worldtides',
            provider: 'WorldTides',
            datumLabel: 'LAT',
            stationName: 'World station',
        });
        expect(result.tides[0].height).toBe(1.4);
    });
    it('ignores an old official object accidentally stored in the WorldTides cache', async () => {
        mocks.cached.mockReturnValue({ tides: [{ height: 99 }], guiDetails: { source: 'official' } });
        mocks.world.mockResolvedValue({
            extremes: [{ date: '2026-10-16T00:00:00Z', type: 'Low', height: 0.1 }],
            responseDatum: 'LAT',
        });
        expect((await fetchRealTides(3, 4)).tides[0].height).toBe(0.1);
    });
});
