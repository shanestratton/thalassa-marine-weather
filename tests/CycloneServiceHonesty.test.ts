/**
 * CycloneTrackingService tells the truth about its sources (129-09): who
 * issued each forecast (NHC/CPHC or JTWC, from the feed's basin), the
 * issuer's own cone, every model's track from fetch-gfs-tracker, and a feed
 * that fails is "unavailable since", never an empty all-clear. A storm that
 * drops out of the feed is kept, marked, for 12 h rather than erased.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/PiCacheService', () => ({ piCache: { isAvailable: () => false } }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeBlocks: () => false }));
vi.mock('../utils/createLogger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

const T0 = Date.parse('2026-10-13T14:00:00Z');
const MIN = 60_000;

interface Feed {
    knack: 'ok' | 'down';
    /** The issuers' forecast points and cones (FeatureServer layers 0 and 4). */
    forecast: 'ok' | 'down';
    storms: string[];
}
const feed: Feed = { knack: 'ok', forecast: 'ok', storms: ['ZZELLA', 'ZZDORA'] };

const knackRow = (name: string) =>
    name === 'ZZELLA'
        ? {
              atcf_id: '41E',
              long_atcf_id: 'ep412026',
              storm_name: 'ZZELLA',
              analysis_time: '2026-10-13T12:00:00.000Z',
              latitude: 18.1,
              longitude: -108.1,
              cyclone_nature: 'HU',
              winds: 80,
              pressure: 960,
              origin_basin: 'E',
              basin: 'EPAC',
          }
        : {
              atcf_id: '38P',
              long_atcf_id: 'sh382027',
              storm_name: 'ZZDORA',
              analysis_time: '2026-10-13T06:00:00.000Z',
              latitude: -15,
              longitude: 153,
              cyclone_nature: 'TS',
              winds: 55,
              pressure: 995,
              origin_basin: 'P',
              basin: 'SHEM',
          };

const point = (name: string, basin: string, num: number, adv: string, lon: number, lat: number, vt: string) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
        STORMNAME: name,
        BASIN: basin,
        STORMNUM: num,
        ADVISNUM: adv,
        ADVDATE: Date.parse('2026-10-13T12:00:00Z'),
        VALIDTIME: vt,
        FLDATELBL: '2026-10-13 5:00 AM Tue MST',
        MAXWIND: 80,
        MSLP: 960,
    },
});

function fetchFixture() {
    return vi.fn(async (input: string) => {
        const url = String(input);
        if (url.includes('api.knackwx.com')) {
            if (feed.knack === 'down') return { ok: false, status: 503, json: async () => ({}) };
            return { ok: true, json: async () => feed.storms.map(knackRow) };
        }
        if (feed.forecast === 'down' && /FeatureServer\/[04]\//.test(url)) {
            return { ok: false, status: 503, json: async () => ({}) };
        }
        if (url.includes('ibtracs.ACTIVE')) return { ok: true, text: async () => 'NAME,ISO_TIME,LAT,LON\nunits\n' };
        if (url.includes('FeatureServer/0'))
            return {
                ok: true,
                json: async () => ({
                    features: [
                        point('Zzella', 'EP', 41, '24A', -108, 18, '13/0900'),
                        point('Zzella', 'EP', 41, '24A', -110.6, 19.9, '14/0900'),
                        point('Zzdora', 'SH', 38, ' ', 153, -15, '13/0600'),
                        point('Zzdora', 'SH', 38, ' ', 151.5, -16.7, '14/0600'),
                    ],
                }),
            };
        if (url.includes('FeatureServer/1')) return { ok: true, json: async () => ({ features: [] }) };
        if (url.includes('FeatureServer/4'))
            return {
                ok: true,
                json: async () => ({
                    features: [
                        {
                            type: 'Feature',
                            geometry: {
                                type: 'Polygon',
                                coordinates: [
                                    [
                                        [-108, 18],
                                        [-112, 22],
                                        [-110, 23],
                                        [-108, 18],
                                    ],
                                ],
                            },
                            properties: { STORMNAME: 'Zzella', BASIN: 'EP', STORMNUM: 41 },
                        },
                    ],
                }),
            };
        if (url.includes('fetch-gfs-tracker'))
            return {
                ok: true,
                json: async () => ({
                    storms: {},
                    gfsCycle: '2026101306',
                    source: 'atcfunix',
                    models: [
                        {
                            storm: 'EP41',
                            tech: 'AVNI',
                            label: 'GFS',
                            by: 'NOAA NCEP',
                            kind: 'model',
                            cycle: '2026-10-13T06:00:00.000Z',
                            points: [
                                [0, 18, -108, 80],
                                [24, 20, -111, 85],
                            ],
                        },
                        {
                            storm: 'SH38',
                            tech: 'EMXI',
                            label: 'ECMWF',
                            by: 'ECMWF',
                            kind: 'model',
                            cycle: '2026-10-13T00:00:00.000Z',
                            points: [
                                [0, -15.1, 153.1, 50],
                                [24, -17, 151, 60],
                            ],
                        },
                        {
                            // Same number, another season's storm half a world away.
                            storm: 'SH38',
                            tech: 'AVNO',
                            label: 'GFS',
                            by: 'NOAA NCEP',
                            kind: 'model',
                            cycle: '2026-10-13T00:00:00.000Z',
                            points: [
                                [0, -20, 60],
                                [24, -22, 58],
                            ],
                        },
                    ],
                }),
            };
        throw new Error(`Unexpected provider request in fixture: ${url}`);
    });
}

async function load() {
    return import('../services/weather/CycloneTrackingService');
}

describe('CycloneTrackingService source honesty', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        vi.stubEnv('VITE_SUPABASE_URL', 'https://fixture.supabase.test');
        feed.knack = 'ok';
        feed.forecast = 'ok';
        feed.storms = ['ZZELLA', 'ZZDORA'];
        localStorage.removeItem('thalassa-cyclone-tracks');
        vi.stubGlobal('fetch', fetchFixture());
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        localStorage.removeItem('thalassa-cyclone-tracks');
    });

    it('names who issued each forecast from the feed’s basin, with the advisory', async () => {
        const svc = await load();
        const storms = await svc.fetchActiveCyclones();
        const ella = storms.find((s) => s.name === 'ZZELLA')!;
        const dora = storms.find((s) => s.name === 'ZZDORA')!;
        expect(ella.forecastBy).toEqual({ by: 'NHC', advisory: '24A', issued: '2026-10-13T12:00:00.000Z' });
        expect(dora.forecastBy?.by).toBe('JTWC');
        // Named for the chart, the card and the push, with the official centre.
        expect(ella.issuer).toEqual({ official: true, text: 'NHC official forecast' });
        expect(ella.centre?.short).toBe('NHC');
        expect(dora.issuer).toEqual({
            official: false,
            text: 'JTWC: US military advisory, not the official warning here',
        });
        expect(dora.centre).toEqual({
            short: 'Bureau of Meteorology',
            url: 'https://www.bom.gov.au/weather-and-climate/warnings-and-alerts',
        });
        // UTC from VALIDTIME: the MST label is not read as UTC.
        expect(ella.forecastTrack[0].time).toBe('2026-10-13T09:00:00.000Z');
    });

    it('attaches the issuer’s own cone, and only where one was published', async () => {
        const svc = await load();
        const storms = await svc.fetchActiveCyclones();
        expect(storms.find((s) => s.name === 'ZZELLA')!.cone?.type).toBe('Polygon');
        expect(storms.find((s) => s.name === 'ZZDORA')!.cone).toBeUndefined();
    });

    it('matches every model track to its storm by number and nearness, never another season’s', async () => {
        const svc = await load();
        await svc.fetchGfsTrackerPositions();
        const storms = await svc.fetchActiveCyclones();
        const ella = svc.modelTracksFor(storms.find((s) => s.name === 'ZZELLA')!);
        expect(ella.map((m) => m.label)).toEqual(['GFS']);
        expect(ella[0].line).toEqual([
            [-108, 18],
            [-111, 20],
        ]);
        const dora = svc.modelTracksFor(storms.find((s) => s.name === 'ZZDORA')!);
        expect(dora.map((m) => `${m.label} ${m.by}`)).toEqual(['ECMWF ECMWF']);
    });

    it('a failed feed is unavailable since then, and keeps the last storms instead of an empty list', async () => {
        const svc = await load();
        expect((await svc.fetchActiveCyclones()).map((s) => s.name).sort()).toEqual(['ZZDORA', 'ZZELLA']);
        expect(svc.cycloneFeedStatus().unavailableSince).toBeNull();
        feed.knack = 'down';
        vi.setSystemTime(T0 + 11 * MIN);
        const during = await svc.fetchActiveCyclones();
        expect(during.map((s) => s.name).sort()).toEqual(['ZZDORA', 'ZZELLA']);
        expect(svc.cycloneFeedStatus().unavailableSince).toBe(T0 + 11 * MIN);
        vi.setSystemTime(T0 + 22 * MIN);
        await svc.fetchActiveCyclones();
        // Since the FIRST failure, not the latest.
        expect(svc.cycloneFeedStatus().unavailableSince).toBe(T0 + 11 * MIN);
        feed.knack = 'ok';
        vi.setSystemTime(T0 + 33 * MIN);
        await svc.fetchActiveCyclones();
        expect(svc.cycloneFeedStatus().unavailableSince).toBeNull();
    });

    it('a failed forecast feed is unavailable since then, apart from the storm list, which still answers', async () => {
        feed.forecast = 'down';
        const svc = await load();
        const storms = await svc.fetchActiveCyclones();
        expect(storms.map((s) => s.name).sort()).toEqual(['ZZDORA', 'ZZELLA']);
        expect(storms.every((s) => !s.forecastBy && !s.cone)).toBe(true);
        expect(svc.cycloneFeedStatus()).toEqual({
            unavailableSince: null,
            forecastUnavailableSince: T0,
            coneUnavailableSince: T0,
        });
        vi.setSystemTime(T0 + 11 * MIN);
        await svc.fetchActiveCyclones();
        expect(svc.cycloneFeedStatus().forecastUnavailableSince).toBe(T0);
        feed.forecast = 'ok';
        vi.setSystemTime(T0 + 22 * MIN);
        expect((await svc.fetchActiveCyclones()).find((s) => s.name === 'ZZELLA')?.forecastBy?.by).toBe('NHC');
        expect(svc.cycloneFeedStatus().forecastUnavailableSince).toBeNull();
        expect(svc.cycloneFeedStatus().coneUnavailableSince).toBeNull();
    });

    it('with no storms ever loaded, a failed feed is still unavailable, not "none"', async () => {
        feed.knack = 'down';
        const svc = await load();
        expect(await svc.fetchActiveCyclones()).toEqual([]);
        expect(svc.cycloneFeedStatus().unavailableSince).toBe(T0);
    });

    it('a storm that drops out of the feed is kept, marked, for 12 h, then let go', async () => {
        const svc = await load();
        await svc.fetchActiveCyclones();
        feed.storms = ['ZZELLA'];
        vi.setSystemTime(T0 + 11 * MIN);
        const dropped = (await svc.fetchActiveCyclones()).find((s) => s.name === 'ZZDORA')!;
        expect(dropped.droppedAt).toBe(new Date(T0 + 11 * MIN).toISOString());
        vi.setSystemTime(T0 + 11 * MIN + 11 * 60 * MIN);
        expect((await svc.fetchActiveCyclones()).find((s) => s.name === 'ZZDORA')?.droppedAt).toBe(
            new Date(T0 + 11 * MIN).toISOString(),
        );
        vi.setSystemTime(T0 + 11 * MIN + 12 * 60 * MIN + MIN);
        expect((await svc.fetchActiveCyclones()).find((s) => s.name === 'ZZDORA')).toBeUndefined();
    });
});
