import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/PiCacheService', () => ({ piCache: { isAvailable: () => false } }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeBlocks: () => false }));
vi.mock('../utils/createLogger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

function providerFetch(name: string, forecast: boolean) {
    return vi.fn(async (input: string) => {
        const url = String(input);
        if (url.endsWith('/functions/v1/cyclone-feed'))
            return {
                ok: true,
                json: async () => ({
                    generatedAt: '2026-09-27T00:00:00.000Z',
                    sources: { nhc: 'ok', jtwc: 'ok', vitals: 'ok', noaa: 'none', jtwcTracks: 'ok' },
                    storms: [
                        {
                            key: 'SH01',
                            sid: 'sh012027',
                            name,
                            basin: 'P',
                            nature: '',
                            current: { lat: -20, lon: 155, time: '2026-09-27T00:00:00Z', windKts: 70, pressureMb: 980 },
                            positionBy: 'JTWC',
                            from: ['vitals'],
                            ...(forecast
                                ? {
                                      forecast: {
                                          by: 'JTWC',
                                          advisory: '3',
                                          issued: '2026-09-27T00:00:00.000Z',
                                          points: [
                                              {
                                                  lat: -21,
                                                  lon: 156,
                                                  time: '2026-09-27T12:00:00.000Z',
                                                  windKts: 75,
                                                  pressureMb: 975,
                                              },
                                              {
                                                  lat: -22,
                                                  lon: 157,
                                                  time: '2026-09-28T00:00:00.000Z',
                                                  windKts: 80,
                                                  pressureMb: 970,
                                              },
                                          ],
                                          past: [],
                                      },
                                  }
                                : {}),
                        },
                    ],
                }),
            };
        if (url.includes('ibtracs.ACTIVE'))
            return {
                ok: true,
                text: async () =>
                    `NAME,ISO_TIME,LAT,LON,USA_WIND,USA_PRES\nunits,units,units,units,units,units\n${name},2026-09-26T12:00:00Z,-18,154,65,985\n${name},2026-09-26T18:00:00Z,-19,154.5,68,983`,
            };
        throw new Error('Unexpected provider request in fixture');
    });
}

describe('cyclone forecast source boundary', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
        vi.stubEnv('VITE_SUPABASE_URL', 'https://fixture.supabase.test');
        localStorage.removeItem('thalassa-cyclone-tracks');
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
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
