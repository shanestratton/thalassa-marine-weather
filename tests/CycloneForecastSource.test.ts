import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/PiCacheService', () => ({ piCache: { isAvailable: () => false } }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeBlocks: () => false }));
vi.mock('../utils/createLogger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

function providerFetch(name: string, forecast: boolean) {
    return vi.fn(async (input: string) => {
        const url = String(input);
        if (url.includes('api.knackwx.com'))
            return {
                ok: true,
                json: async () => [
                    {
                        atcf_id: '01P',
                        long_atcf_id: 'CP012026',
                        storm_name: name,
                        analysis_time: '2026-09-27T00:00:00Z',
                        latitude: -20,
                        longitude: 155,
                        cyclone_nature: 'TC',
                        winds: 70,
                        pressure: 980,
                        origin_basin: 'P',
                    },
                ],
            };
        if (url.includes('ibtracs.ACTIVE'))
            return {
                ok: true,
                text: async () =>
                    `NAME,ISO_TIME,LAT,LON,USA_WIND,USA_PRES\nunits,units,units,units,units,units\n${name},2026-09-26T12:00:00Z,-18,154,65,985\n${name},2026-09-26T18:00:00Z,-19,154.5,68,983`,
            };
        if (url.includes('FeatureServer/0'))
            return {
                ok: true,
                json: async () => ({
                    features: forecast
                        ? [
                              {
                                  geometry: { type: 'Point', coordinates: [156, -21] },
                                  properties: {
                                      STORMNAME: name,
                                      MAXWIND: 75,
                                      MSLP: 975,
                                      FLDATELBL: '2026-09-27 12:00 PM',
                                  },
                              },
                              {
                                  geometry: { type: 'Point', coordinates: [157, -22] },
                                  properties: {
                                      STORMNAME: name,
                                      MAXWIND: 80,
                                      MSLP: 970,
                                      FLDATELBL: '2026-09-28 12:00 AM',
                                  },
                              },
                          ]
                        : [],
                }),
            };
        if (url.includes('FeatureServer/1')) return { ok: true, json: async () => ({ features: [] }) };
        throw new Error('Unexpected provider request in fixture');
    });
}

describe('cyclone forecast source boundary', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
        localStorage.removeItem('thalassa-cyclone-tracks');
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        localStorage.removeItem('thalassa-cyclone-tracks');
    });

    it('preserves observed history but never invents a forecast for an uncovered basin', async () => {
        vi.stubGlobal('fetch', providerFetch('SOUTH', false));
        const { fetchActiveCyclones } = await import('../services/weather/CycloneTrackingService');
        const [cyclone] = await fetchActiveCyclones();
        expect(cyclone.track).toHaveLength(3);
        expect(cyclone.currentPosition).toMatchObject({ lat: -20, lon: 155, windKts: 70 });
        expect(cyclone.forecastTrack).toEqual([]);
    });

    it('preserves actual provider forecast points instead of replacing or extrapolating them', async () => {
        vi.stubGlobal('fetch', providerFetch('NORTH', true));
        const { fetchActiveCyclones } = await import('../services/weather/CycloneTrackingService');
        const [cyclone] = await fetchActiveCyclones();
        expect(cyclone.track).toHaveLength(3);
        expect(cyclone.forecastTrack).toEqual([
            { lat: -21, lon: 156, time: '2026-09-27T12:00:00.000Z', windKts: 75, pressureMb: 975 },
            { lat: -22, lon: 157, time: '2026-09-28T00:00:00.000Z', windKts: 80, pressureMb: 970 },
        ]);
    });
});
