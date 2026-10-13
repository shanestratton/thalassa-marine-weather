/**
 * CycloneTrackingService tells the truth about its sources (129-09, and
 * 129-09b: the storm list and the issuers' tracks now come from the
 * cyclone-feed edge function, direct from NHC/CPHC (NOAA), JTWC and NCEP, with
 * no Esri and no knackwx): who issued each forecast, the issuer's own cone,
 * every model's track from fetch-gfs-tracker, and a feed that fails is
 * "unavailable since", never an empty all-clear, per storm list as well as
 * whole. A storm that drops out of the feed is kept, marked, for 12 h rather
 * than erased.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CycloneFeed, FeedStorm } from '../supabase/functions/_shared/cyclone/feed';

/** The boat's Pi: off, or serving its own copy of the feed. */
const pi = vi.hoisted(() => ({ serve: null as null | (() => unknown) }));
vi.mock('../services/PiCacheService', () => ({
    piCache: {
        isAvailable: () => pi.serve !== null,
        fetch: async (_path: string, _q: unknown, direct: () => Promise<unknown>) =>
            pi.serve
                ? { data: pi.serve(), source: 'pi-stale', latencyMs: 1 }
                : { data: await direct(), source: 'direct', latencyMs: 1 },
    },
}));
vi.mock('../services/networkPolicy', () => ({ satelliteModeBlocks: () => false }));
vi.mock('../utils/createLogger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

const T0 = Date.parse('2026-10-13T14:00:00Z');
const MIN = 60_000;

interface Feed {
    /** The cyclone-feed function itself. */
    catalogue: 'ok' | 'down';
    /** The issuers' tracks and cones (NOAA's MapServer, JTWC's products). */
    forecast: 'ok' | 'down';
    /** Storm lists that did not answer, inside an answering feed. */
    listsDown: ('nhc' | 'jtwc' | 'vitals')[];
    storms: string[];
    /** JTWC warnings whose product did not come, placed by no list. */
    unplaced: CycloneFeed['unplaced'];
}
const feed: Feed = { catalogue: 'ok', forecast: 'ok', listsDown: [], storms: ['ZZELLA', 'ZZDORA'], unplaced: [] };
const urls: string[] = [];

const CONE = {
    type: 'Polygon' as const,
    coordinates: [
        [
            [-108, 18],
            [-112, 22],
            [-110, 23],
            [-108, 18],
        ],
    ],
};

function feedStorm(name: string): FeedStorm {
    const down = feed.forecast === 'down';
    if (name === 'ZZELLA') {
        return {
            key: 'EP41',
            sid: 'ep412026',
            name: 'ZZELLA',
            basin: 'E',
            nature: 'HU',
            current: { lat: 18.1, lon: -108.1, time: '2026-10-13T12:00:00.000Z', windKts: 80, pressureMb: 960 },
            positionBy: 'NHC',
            from: ['nhc', 'vitals'],
            ...(down
                ? { forecastUnavailable: true as const }
                : {
                      forecast: {
                          by: 'NHC' as const,
                          advisory: '24A',
                          issued: '2026-10-13T12:00:00.000Z',
                          points: [
                              { lat: 18, lon: -108, time: '2026-10-13T09:00:00.000Z', windKts: 80, pressureMb: 960 },
                              {
                                  lat: 19.9,
                                  lon: -110.6,
                                  time: '2026-10-14T09:00:00.000Z',
                                  windKts: 80,
                                  pressureMb: 960,
                              },
                          ],
                          past: [
                              {
                                  lat: 17.1,
                                  lon: -106.4,
                                  time: '2026-10-13T00:00:00.000Z',
                                  windKts: 70,
                                  pressureMb: null,
                              },
                              {
                                  lat: 17.6,
                                  lon: -107.2,
                                  time: '2026-10-13T06:00:00.000Z',
                                  windKts: 75,
                                  pressureMb: 965,
                              },
                          ],
                          cone: CONE,
                      },
                  }),
        };
    }
    return {
        key: 'SH38',
        sid: 'sh382027',
        name: 'ZZDORA',
        basin: 'P',
        nature: '',
        current: { lat: -15, lon: 153, time: '2026-10-13T06:00:00.000Z', windKts: 55, pressureMb: 995 },
        positionBy: 'JTWC',
        from: ['jtwc', 'vitals'],
        ...(down
            ? { forecastUnavailable: true as const }
            : {
                  forecast: {
                      by: 'JTWC' as const,
                      advisory: '12',
                      issued: '2026-10-13T09:00:00.000Z',
                      points: [
                          { lat: -15, lon: 153, time: '2026-10-13T06:00:00.000Z', windKts: 55, pressureMb: null },
                          { lat: -16.7, lon: 151.5, time: '2026-10-14T06:00:00.000Z', windKts: 65, pressureMb: null },
                      ],
                      past: [],
                  },
              }),
    };
}

function feedBody(): CycloneFeed {
    const down = new Set(feed.listsDown);
    return {
        generatedAt: new Date(Date.now()).toISOString(),
        storms: feed.storms.map(feedStorm),
        sources: {
            nhc: down.has('nhc') ? 'unavailable' : 'ok',
            jtwc: down.has('jtwc') ? 'unavailable' : 'ok',
            vitals: down.has('vitals') ? 'unavailable' : 'ok',
            noaa: feed.forecast === 'down' ? 'unavailable' : 'ok',
            jtwcTracks: feed.forecast === 'down' || feed.unplaced.length ? 'unavailable' : 'ok',
        },
        unplaced: feed.unplaced,
    };
}

function fetchFixture() {
    return vi.fn(async (input: string) => {
        const url = String(input);
        urls.push(url);
        if (url === 'https://fixture.supabase.test/functions/v1/cyclone-feed') {
            if (feed.catalogue === 'down') return { ok: false, status: 503, json: async () => ({}) };
            return { ok: true, json: async () => feedBody() };
        }
        if (url.includes('ibtracs.ACTIVE')) return { ok: true, text: async () => 'NAME,ISO_TIME,LAT,LON\nunits\n' };
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
        feed.catalogue = 'ok';
        feed.forecast = 'ok';
        feed.listsDown = [];
        feed.storms = ['ZZELLA', 'ZZDORA'];
        feed.unplaced = [];
        pi.serve = null;
        urls.length = 0;
        localStorage.removeItem('thalassa-cyclone-tracks');
        vi.stubGlobal('fetch', fetchFixture());
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        localStorage.removeItem('thalassa-cyclone-tracks');
    });

    it('names who issued each forecast, with the advisory, from the warning centres’ own feed', async () => {
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
        // The feed's UTC times, as given (NOAA's VALIDTIME, never its MST label).
        expect(ella.forecastTrack[0].time).toBe('2026-10-13T09:00:00.000Z');
        expect(ella.basin).toBe('E');
        expect(ella.positionBy).toBe('NHC');
        expect(dora.sid).toBe('sh382027');
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
        feed.catalogue = 'down';
        vi.setSystemTime(T0 + 11 * MIN);
        const during = await svc.fetchActiveCyclones();
        expect(during.map((s) => s.name).sort()).toEqual(['ZZDORA', 'ZZELLA']);
        expect(svc.cycloneFeedStatus().unavailableSince).toBe(T0 + 11 * MIN);
        vi.setSystemTime(T0 + 22 * MIN);
        await svc.fetchActiveCyclones();
        // Since the FIRST failure, not the latest.
        expect(svc.cycloneFeedStatus().unavailableSince).toBe(T0 + 11 * MIN);
        feed.catalogue = 'ok';
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
            sourcesUnavailable: [],
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
        feed.catalogue = 'down';
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

    it('keeps the issuer’s own past track when it is longer than IBTrACS’s', async () => {
        const svc = await load();
        const ella = (await svc.fetchActiveCyclones()).find((s) => s.name === 'ZZELLA')!;
        expect(ella.track.map((p) => p.time)).toEqual([
            '2026-10-13T00:00:00.000Z',
            '2026-10-13T06:00:00.000Z',
            '2026-10-13T12:00:00.000Z',
        ]);
    });

    it('a storm list that did not answer is said by name, since it first failed, and cleared when it answers', async () => {
        feed.listsDown = ['jtwc'];
        const svc = await load();
        expect((await svc.fetchActiveCyclones()).map((s) => s.name).sort()).toEqual(['ZZDORA', 'ZZELLA']);
        expect(svc.cycloneFeedStatus().unavailableSince).toBeNull();
        expect(svc.cycloneFeedStatus().sourcesUnavailable).toEqual([{ source: 'JTWC', since: T0 }]);
        feed.listsDown = ['jtwc', 'vitals'];
        vi.setSystemTime(T0 + 11 * MIN);
        await svc.fetchActiveCyclones();
        expect(svc.cycloneFeedStatus().sourcesUnavailable).toEqual([
            { source: 'JTWC', since: T0 },
            { source: 'NCEP storm vitals', since: T0 + 11 * MIN },
        ]);
        feed.listsDown = [];
        vi.setSystemTime(T0 + 22 * MIN);
        await svc.fetchActiveCyclones();
        expect(svc.cycloneFeedStatus().sourcesUnavailable).toEqual([]);
    });

    it('every storm list down is the catalogue unavailable, and the last storms are kept, never an empty ocean', async () => {
        const svc = await load();
        await svc.fetchActiveCyclones();
        feed.listsDown = ['nhc', 'jtwc', 'vitals'];
        feed.storms = [];
        vi.setSystemTime(T0 + 11 * MIN);
        expect((await svc.fetchActiveCyclones()).map((s) => s.name).sort()).toEqual(['ZZDORA', 'ZZELLA']);
        expect(svc.cycloneFeedStatus().unavailableSince).toBe(T0 + 11 * MIN);
    });

    it('a JTWC warning whose product did not come, placed by no list, is said by name, never an empty sea', async () => {
        feed.unplaced = [{ key: 'WP29', name: 'ZZHANUL', warning: '35' }];
        const svc = await load();
        await svc.fetchActiveCyclones();
        expect(svc.cycloneFeedStatus()).toMatchObject({
            unavailableSince: null,
            sourcesUnavailable: [{ source: 'JTWC warning on ZZHANUL (WP29)', since: T0 }],
        });
        feed.unplaced = [
            { key: 'WP29', name: 'ZZHANUL', warning: '36' },
            { key: 'IO02', name: 'IO02', warning: '1' },
        ];
        vi.setSystemTime(T0 + 11 * MIN);
        await svc.fetchActiveCyclones();
        expect(svc.cycloneFeedStatus().sourcesUnavailable).toEqual([
            { source: 'JTWC warnings on ZZHANUL (WP29), IO02', since: T0 },
        ]);
        feed.unplaced = [];
        vi.setSystemTime(T0 + 22 * MIN);
        await svc.fetchActiveCyclones();
        expect(svc.cycloneFeedStatus().sourcesUnavailable).toEqual([]);
    });

    it('the Pi’s old copy of the feed (its uplink down) is unavailable since it was made, its storms the last known', async () => {
        const DAY = 24 * 60 * MIN;
        pi.serve = () => ({ ...feedBody(), generatedAt: new Date(T0 - 2 * DAY).toISOString() });
        const svc = await load();
        expect((await svc.fetchActiveCyclones()).map((s) => s.name).sort()).toEqual(['ZZDORA', 'ZZELLA']);
        expect(svc.cycloneFeedStatus().unavailableSince).toBe(T0 - 2 * DAY);
        // A copy inside the hour is today's ocean.
        vi.setSystemTime(T0 + 11 * MIN);
        pi.serve = () => ({ ...feedBody(), generatedAt: new Date(T0 + 11 * MIN - 50 * MIN).toISOString() });
        await svc.fetchActiveCyclones();
        expect(svc.cycloneFeedStatus().unavailableSince).toBeNull();
    });

    it('never trades newer storms for the Pi’s older copy, and says so once what it holds is past the hour', async () => {
        const DAY = 24 * 60 * MIN;
        const svc = await load();
        await svc.fetchActiveCyclones();
        // On the boat LAN now, and the Pi has only a two-day-old empty copy.
        feed.storms = [];
        pi.serve = () => ({ ...feedBody(), generatedAt: new Date(T0 - 2 * DAY).toISOString() });
        vi.setSystemTime(T0 + 11 * MIN);
        const held = await svc.fetchActiveCyclones();
        expect(held.map((s) => s.name).sort()).toEqual(['ZZDORA', 'ZZELLA']);
        expect(held.every((s) => !s.droppedAt)).toBe(true);
        expect(svc.cycloneFeedStatus().unavailableSince).toBeNull();
        vi.setSystemTime(T0 + 61 * MIN);
        expect((await svc.fetchActiveCyclones()).map((s) => s.name).sort()).toEqual(['ZZDORA', 'ZZELLA']);
        expect(svc.cycloneFeedStatus().unavailableSince).toBe(T0);
    });

    it('asks only Thalassa’s own feed and NCEI, never Esri or knackwx', async () => {
        const svc = await load();
        await svc.fetchActiveCyclones();
        await svc.fetchGfsTrackerPositions();
        expect(urls.length).toBeGreaterThan(0);
        for (const u of urls) expect(new URL(u).hostname).toMatch(/^(fixture\.supabase\.test|www\.ncei\.noaa\.gov)$/);
    });
});
