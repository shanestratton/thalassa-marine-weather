/**
 * Nearest wave buoy, worldwide (build 123, W1-11).
 *
 * Every fixture under tests/fixtures/buoys is a REAL public response, captured
 * 2026-10-07 ~17:00 UTC and trimmed to a handful of rows:
 *   - NDBC latest_obs.txt (one file, every station's newest row) and two
 *     5-day spectral summaries (46026 off San Francisco, 62107 UK Met Office);
 *   - the Queensland wave feed (CKAN resource 2bbef99e…, re-ingested from the
 *     DES CSV every few minutes) in `lists` form, plus a day-old `objects`
 *     capture whose height column was then called `Hsig` (it is `Hs` today);
 *   - the Irish Marine Institute ERDDAP dataset IWBNetwork;
 *   - UNTRIMMED neighbourhoods of latest_obs.txt (every station within 50 NM
 *     of three taps, tide gauges and airports included) with the 5-day
 *     spectral files of the buoys behind them (42035, 46041, 46013), cut to
 *     the rows that existed at 17:00 UTC.
 *
 * The cases go round the world on purpose: the US west coast, Korea, the North
 * Sea, the English Channel, Hawaii, American Samoa, Palau, Puerto Rico,
 * British Columbia, the west of Ireland and Queensland — plus the Indian Ocean,
 * where there is honestly nothing.
 *
 * Rows marked FICTIONAL below are invented to exercise one QC rule each.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({
    get: vi.fn(),
    native: { value: true },
}));
vi.mock('@capacitor/core', () => ({
    CapacitorHttp: { get: http.get },
    Capacitor: { isNativePlatform: () => http.native.value },
}));

const pi = vi.hoisted(() => ({
    passthroughJson: vi.fn(),
    passthroughText: vi.fn(),
}));
vi.mock('../services/PiCacheService', () => ({ piCache: pi }));

import {
    BUOY_CACHE_TTL_MS,
    BUOY_MAX_AGE_MS,
    BUOY_RADIUS_NM,
    findNearestWaveBuoy,
    resetBuoyFeedCache,
} from '../services/weather/buoys/feed';
import { describeNearestBuoy } from '../services/weather/buoys/describe';
import {
    NDBC_LATEST_OBS_URL,
    ndbcOwner,
    ndbcSpecUrl,
    parseNdbcLatestObs,
    parseNdbcSpecSummary,
} from '../services/weather/buoys/providers/ndbc';
import { QLD_WAVES_URL, parseQldDesCkan } from '../services/weather/buoys/providers/qldDes';
import { IRISH_MI_URL, parseIrishMiErddap } from '../services/weather/buoys/providers/irishMI';
import { qcObservation } from '../services/weather/buoys/qc';
import type { BuoyObs } from '../services/weather/buoys/types';

const fixture = (name: string): string =>
    fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/buoys', name), 'utf8');

const NDBC_LATEST = fixture('ndbc-latest-obs-2026-10-07T1655Z.txt');
const NDBC_SPEC_46026 = fixture('ndbc-5day-spec-46026-2026-10-07.txt');
const NDBC_SPEC_62107 = fixture('ndbc-5day-spec-62107-2026-10-07.txt');
const NDBC_NEIGHBOURHOODS = fixture('ndbc-latest-obs-neighbourhoods-2026-10-07T1658Z.txt');
const NDBC_SPEC = Object.fromEntries(
    ['42035', '46041', '46013'].map((id) => [id, fixture(`ndbc-5day-spec-${id}-2026-10-07.txt`)]),
);
const QLD_LISTS = JSON.parse(fixture('qld-des-ckan-latest-2026-10-07T1705Z.json'));
const QLD_HSIG = JSON.parse(fixture('qld-des-ckan-hsig-objects-2026-10-07T0440Z.json'));
const IRISH = JSON.parse(fixture('irish-mi-iwbnetwork-latest-2026-10-07T1700Z.json'));

const NOW = Date.UTC(2026, 9, 7, 17, 5);
const METRIC = { waveHeight: 'm', distance: 'nm' } as const;

/** Route each upstream URL to its captured body. */
function serveFixtures(overrides: Record<string, { status: number; data: unknown }> = {}): void {
    http.get.mockImplementation(async ({ url }: { url: string }) => {
        if (overrides[url]) return overrides[url];
        if (url === NDBC_LATEST_OBS_URL) return { status: 200, data: NDBC_LATEST };
        if (url === ndbcSpecUrl('46026')) return { status: 200, data: NDBC_SPEC_46026 };
        if (url === ndbcSpecUrl('62107')) return { status: 200, data: NDBC_SPEC_62107 };
        if (url === QLD_WAVES_URL) return { status: 200, data: QLD_LISTS };
        if (url === IRISH_MI_URL) return { status: 200, data: IRISH };
        return { status: 404, data: '<html>404 Not Found</html>' };
    });
}

const urlsFetched = (): string[] => http.get.mock.calls.map(([req]) => (req as { url: string }).url);

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    http.get.mockReset();
    http.native.value = true;
    pi.passthroughJson.mockReset().mockResolvedValue(null);
    pi.passthroughText.mockReset().mockResolvedValue(null);
    resetBuoyFeedCache();
    serveFixtures();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('NDBC latest_obs.txt reader', () => {
    const rows = parseNdbcLatestObs(NDBC_LATEST);
    const byId = (id: string) => rows.find((r) => r.key === `ndbc:${id}`);

    it('reads every station row by column NAME, in UTC', () => {
        expect(rows).toHaveLength(21);
        const cdip = byId('46237');
        expect(cdip).toMatchObject({
            network: 'ndbc',
            label: 'NDBC 46237',
            lat: 37.788,
            lon: -122.634,
            hsM: 1.1,
            periodS: 13,
            fromDeg: 259,
            sstC: 15.5,
        });
        expect(cdip?.time).toBe(Date.UTC(2026, 9, 7, 16, 30));
    });

    it('MM is no reading, and a met-only row keeps its place without a wave height', () => {
        const sf = byId('46026');
        expect(sf).toBeDefined();
        expect(sf?.hsM).toBeNull();
        expect(sf?.periodS).toBeNull();
        expect(sf?.fromDeg).toBeNull();
    });

    it('a zero dominant period (KMA sends DPD 0) is not a period', () => {
        expect(byId('22104')).toMatchObject({ hsM: 0.5, periodS: null, fromDeg: null });
    });

    it('credits the owner, including partner stations inside NDBC', () => {
        expect(ndbcOwner('46026')).toBe('NDBC');
        expect(ndbcOwner('46237')).toBe('Scripps CDIP');
        expect(ndbcOwner('62107')).toBe('UK Met Office');
        expect(ndbcOwner('62144')).toBe('UK offshore platform');
        expect(ndbcOwner('22104')).toBe('Korea Met. Administration');
        expect(ndbcOwner('51201')).toBe('PacIOOS');
        expect(ndbcOwner('41121')).toBe('CariCOOS');
        expect(ndbcOwner('46181')).toBe('Environment Canada');
        // Ocean Station Papa: reporting waves on 2026-10-07, owner code WQ.
        expect(ndbcOwner('46246')).toBe('APL-UW');
        expect(byId('62107')?.owner).toBe('UK Met Office');
        // Not in the table: no invented owner.
        expect(ndbcOwner('99999')).toBeNull();
    });
});

describe('NDBC 5-day spectral summary (the wave half of an NDBC buoy)', () => {
    const station = parseNdbcLatestObs(NDBC_LATEST).find((r) => r.key === 'ndbc:46026') as BuoyObs;

    it('takes the newest row, and the dominant partition’s period', () => {
        const obs = parseNdbcSpecSummary(NDBC_SPEC_46026, station);
        expect(obs).toMatchObject({ key: 'ndbc:46026', hsM: 1.3, periodS: 12.9, fromDeg: 270, lat: 37.75 });
        expect(obs?.time).toBe(Date.UTC(2026, 9, 7, 16, 10));
    });

    it('MWD -99 is a sentinel, and wind-sea-only rows use the wind-wave period', () => {
        const ukmo = parseNdbcLatestObs(NDBC_LATEST).find((r) => r.key === 'ndbc:62107') as BuoyObs;
        const obs = parseNdbcSpecSummary(NDBC_SPEC_62107, ukmo);
        expect(obs).toMatchObject({ hsM: 2.5, periodS: 7, fromDeg: null });
        expect(obs?.time).toBe(Date.UTC(2026, 9, 7, 12, 0));
    });
});

describe('Queensland wave reader', () => {
    const rows = parseQldDesCkan(QLD_LISTS);

    it('uses the Seconds epoch, never the zoneless local DateTime', () => {
        const bne = rows.find((r) => r.label === 'Brisbane Mk4');
        // DateTime says "2026-10-08T01:30:00" — that is AEST, not UTC.
        expect(bne?.time).toBe(Date.UTC(2026, 9, 7, 15, 30));
        expect(bne).toMatchObject({ hsM: 2.44, periodS: 8.7, fromDeg: 161.26, owner: 'State of Queensland' });
    });

    it('Seconds wins even when DateTime disagrees outright, whatever the test clock’s zone (FICTIONAL row)', () => {
        const [row] = parseQldDesCkan({
            success: true,
            result: {
                records: [
                    {
                        Site: 'Fictional Bank',
                        SiteNumber: '9003',
                        Seconds: '1791387000',
                        DateTime: '2019-04-09T00:00:00',
                        Latitude: '-20.3',
                        Longitude: '150.3',
                        Hs: '1.10',
                    },
                ],
            },
        });
        expect(row.time).toBe(Date.UTC(2026, 9, 7, 15, 30));
    });

    it('carries the live site names (all 26 of them)', () => {
        const names = new Set(rows.map((r) => r.label));
        expect(names.size).toBe(26);
        for (const live of ['Brisbane Mk4', 'Gold Coast Mk4', 'Tweed Offshore', 'Tweed Heads Mk4', 'Wide Bay']) {
            expect(names.has(live), live).toBe(true);
        }
    });

    it('reads the height column whichever name it has today (Hs) or had yesterday (Hsig)', () => {
        const old = parseQldDesCkan(QLD_HSIG);
        const bne = old.find((r) => r.label === 'Brisbane Mk4');
        expect(bne?.hsM).toBe(2.52);
        expect(bne?.time).toBe(Date.UTC(2026, 9, 7, 2, 30));
    });

    it('-99.9 is a sentinel, not a reading (FICTIONAL rows)', () => {
        const made = parseQldDesCkan({
            success: true,
            result: {
                fields: [
                    { id: 'Site' },
                    { id: 'SiteNumber' },
                    { id: 'Seconds' },
                    { id: 'Latitude' },
                    { id: 'Longitude' },
                    { id: 'Hs' },
                    { id: 'Tp' },
                    { id: 'SST' },
                    { id: 'Direction' },
                ],
                records: [
                    ['Fictional Reef', '9001', '1791387000', '-20.1', '150.1', '1.20', '-99.90', '-99.90', '-99.90'],
                    ['Fictional Shoal', '9002', '1791387000', '-20.2', '150.2', '-99.90', '7.10', '24.0', '90'],
                ],
            },
        });
        expect(made[0]).toMatchObject({ hsM: 1.2, periodS: null, sstC: null, fromDeg: null });
        expect(made[1].hsM).toBeNull();
        expect(qcObservation(made[1], NOW)).toBeNull();
    });
});

describe('Irish Marine Institute IWBNetwork reader', () => {
    it('reads the live dataset: Tp as the period, MeanWaveDirection as from-direction', () => {
        const rows = parseIrishMiErddap(IRISH);
        expect(rows.map((r) => r.label)).toEqual(['M2 buoy', 'M3 buoy', 'M5 buoy', 'M6 buoy']);
        expect(rows[1]).toMatchObject({
            key: 'irish-mi:M3',
            owner: 'Marine Institute',
            hsM: 2.695,
            periodS: 11.133,
            fromDeg: 319,
            sstC: 15.251,
        });
        expect(rows[1].time).toBe(Date.UTC(2026, 9, 7, 16, 0));
    });

    it('asks with an ENCODED query (a raw ">" earns a Tomcat 400) against IWBNetwork, not the dead IMI-EATL-WAVE', () => {
        expect(IRISH_MI_URL).toContain('/tabledap/IWBNetwork.json?');
        expect(IRISH_MI_URL).not.toContain('IMI-EATL-WAVE');
        expect(IRISH_MI_URL).not.toMatch(/[>"]/);
    });

    it('drops QC_Flag 9 (missing) rows and -999 fill values (FICTIONAL rows)', () => {
        const rows = parseIrishMiErddap({
            table: {
                columnNames: [
                    'station_id',
                    'longitude',
                    'latitude',
                    'time',
                    'WaveHeight',
                    'Tp',
                    'MeanWaveDirection',
                    'SeaTemperature',
                    'QC_Flag',
                ],
                rows: [
                    ['M9', -9.9, 53.1, '2026-10-07T16:00:00Z', 1.5, -999, -999, 14.1, 0],
                    ['M8', -9.8, 53.2, '2026-10-07T16:00:00Z', 1.7, 9.1, 250, 14.2, 9],
                ],
            },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ key: 'irish-mi:M9', hsM: 1.5, periodS: null, fromDeg: null });
    });
});

describe('QC', () => {
    const base: BuoyObs = {
        key: 'test:1',
        network: 'ndbc',
        label: 'FICTIONAL 1',
        owner: 'Fictional Owner',
        lat: 10,
        lon: 10,
        time: NOW - 30 * 60_000,
        hsM: 1.2,
        periodS: 9,
        fromDeg: 120,
        sstC: 25,
    };

    it('keeps a sane row', () => {
        expect(qcObservation(base, NOW)).toEqual(base);
    });

    it('drops a stale row (older than 3 h)', () => {
        expect(qcObservation({ ...base, time: NOW - BUOY_MAX_AGE_MS - 1 }, NOW)).toBeNull();
        expect(qcObservation({ ...base, time: NOW - BUOY_MAX_AGE_MS + 60_000 }, NOW)).not.toBeNull();
    });

    it('drops 0,0 positions (seen live on three Queensland port buoys)', () => {
        expect(qcObservation({ ...base, lat: 0, lon: 0 }, NOW)).toBeNull();
    });

    it('drops a flat zero: 0.0 m is a dead sensor, not a calm sea we can vouch for', () => {
        expect(qcObservation({ ...base, hsM: 0 }, NOW)).toBeNull();
    });

    it('drops rows from the future and absurd heights; blanks absurd periods and directions', () => {
        expect(qcObservation({ ...base, time: NOW + 60 * 60_000 }, NOW)).toBeNull();
        expect(qcObservation({ ...base, hsM: 99 }, NOW)).toBeNull();
        expect(qcObservation({ ...base, periodS: 0, fromDeg: 999, sstC: 99 }, NOW)).toMatchObject({
            periodS: null,
            fromDeg: null,
            sstC: null,
        });
    });
});

describe('findNearestWaveBuoy — around the world', () => {
    it('San Francisco: the met-only NDBC buoy is nearer, so its wave half is fetched (one 17 KB file)', async () => {
        const result = await findNearestWaveBuoy(37.7, -122.75);
        expect(result.status).toBe('found');
        if (result.status !== 'found') return;
        expect(result.obs.key).toBe('ndbc:46026');
        expect(result.distanceNm).toBeCloseTo(5.1, 0);
        expect(describeNearestBuoy(result, METRIC, NOW)).toBe(
            'Measured 1.3 m · 13 s from W · NDBC 46026 · 5 NM · 55 min ago',
        );
        expect(urlsFetched()).toEqual([NDBC_LATEST_OBS_URL, ndbcSpecUrl('46026')]);
        // NDBC is plain text; the Pi passthrough only proxies JSON, so it never goes that way.
        expect(pi.passthroughText).not.toHaveBeenCalled();
    });

    it('San Francisco: when the wave half is missing, the next buoy with waves answers, owner credited', async () => {
        serveFixtures({ [ndbcSpecUrl('46026')]: { status: 404, data: 'Not Found' } });
        const result = await findNearestWaveBuoy(37.7, -122.75);
        expect(describeNearestBuoy(result, METRIC, NOW)).toBe(
            'Measured 1.1 m · 13 s from W · NDBC 46237 (Scripps CDIP) · 8 NM · 35 min ago',
        );
    });

    it('Korea (KMA partner station): no period is shown rather than "0 s"', async () => {
        const result = await findNearestWaveBuoy(34.7, 128.8);
        expect(describeNearestBuoy(result, METRIC, NOW)).toBe(
            'Measured 0.5 m · NDBC 22104 (Korea Met. Administration) · 6 NM · 1 h 5 min ago',
        );
    });

    it('North Sea and English Channel partner stations', async () => {
        expect(describeNearestBuoy(await findNearestWaveBuoy(53.5, 1.5), METRIC, NOW)).toBe(
            'Measured 1.9 m · NDBC 62144 (UK offshore platform) · 9 NM · 1 h 5 min ago',
        );
        expect(describeNearestBuoy(await findNearestWaveBuoy(50.0, -6.0), METRIC, NOW)).toBe(
            'Measured 2.1 m · NDBC 62107 (UK Met Office) · 7 NM · 1 h 5 min ago',
        );
    });

    it('Hawaii, American Samoa, Palau and Puerto Rico', async () => {
        const at = async (lat: number, lon: number) => {
            const r = await findNearestWaveBuoy(lat, lon);
            return r.status === 'found' ? r.obs.key : r.status;
        };
        expect(await at(21.6, -158.2)).toBe('ndbc:51201');
        expect(await at(-14.2, -170.6)).toBe('ndbc:51209');
        expect(await at(7.5, 134.5)).toBe('ndbc:52212');
        expect(await at(18.6, -66.8)).toBe('ndbc:41121');
    });

    it('British Columbia: the only buoy in range reads 0.0 m, so there is honestly none', async () => {
        const result = await findNearestWaveBuoy(53.8, -128.9);
        expect(result).toMatchObject({ status: 'none', radiusNm: BUOY_RADIUS_NM, unreachable: [], covered: true });
        expect(describeNearestBuoy(result, METRIC, NOW)).toBe('No wave buoy reporting within 50 NM');
        // A rejected reading is not a missing one: no second look at its wave file.
        expect(urlsFetched()).toEqual([NDBC_LATEST_OBS_URL]);
    });

    it('west of Ireland: Marine Institute M3', async () => {
        const result = await findNearestWaveBuoy(51.3, -10.4);
        expect(describeNearestBuoy(result, METRIC, NOW)).toBe(
            'Measured 2.7 m · 11 s from NW · M3 buoy (Marine Institute) · 8 NM · 1 h 5 min ago',
        );
    });

    it('Queensland: the live site, timed by its Seconds epoch', async () => {
        const result = await findNearestWaveBuoy(-27.45, 153.55);
        expect(describeNearestBuoy(result, METRIC, NOW)).toBe(
            'Measured 2.4 m · 9 s from SSE · Brisbane Mk4 (State of Queensland) · 5 NM · 1 h 35 min ago',
        );
    });

    it('Queensland: a 0,0 newest row falls back to the same buoy’s previous good row', async () => {
        const result = await findNearestWaveBuoy(-21.1, 149.25);
        expect(result.status).toBe('found');
        if (result.status !== 'found') return;
        expect(result.obs.label).toBe('Mackay Harbour (east of southern breakwater)');
        expect(result.obs.time).toBe(1791387600 * 1000);
        expect(result.obs.lat).toBeCloseTo(-21.1126, 4);
    });

    it('Queensland goes through the Pi first when it answers (JSON lane)', async () => {
        pi.passthroughJson.mockResolvedValue(QLD_LISTS);
        const result = await findNearestWaveBuoy(-27.45, 153.55);
        expect(result.status).toBe('found');
        expect(pi.passthroughJson).toHaveBeenCalledWith(QLD_WAVES_URL, BUOY_CACHE_TTL_MS, 'qld-wave-buoys');
        expect(urlsFetched()).not.toContain(QLD_WAVES_URL);
    });

    it('Indian Ocean: no network covers it, nothing is fetched, and it says so plainly', async () => {
        const result = await findNearestWaveBuoy(-20, 70);
        expect(result).toEqual({ status: 'none', radiusNm: 50, unreachable: [], covered: false });
        expect(http.get).not.toHaveBeenCalled();
        expect(pi.passthroughJson).not.toHaveBeenCalled();
        expect(describeNearestBuoy(result, METRIC, NOW)).toBe('No wave buoy feed read here yet');
    });

    it('off Sydney, Marseille and Tokyo Bay it never claims there is no buoy: no feed is read there yet', async () => {
        for (const [lat, lon] of [
            [-33.85, 151.35],
            [43.25, 5.3],
            [35.3, 139.75],
        ]) {
            const result = await findNearestWaveBuoy(lat, lon);
            expect(describeNearestBuoy(result, METRIC, NOW), `${lat},${lon}`).toBe('No wave buoy feed read here yet');
        }
    });

    it('every NDBC-listed buoy is inside a coverage box: taps beside the outliers ask NDBC', async () => {
        // Positions from NDBC station_table.txt, 2026-10-07.
        const outliers: Array<[string, number, number]> = [
            ['41041 tropical Atlantic', 14.259, -46.052],
            ['46070 Bering Sea, east longitude', 55.048, 175.246],
            ['46071 western Aleutians, east longitude', 51.035, 179.808],
            ['62442 Porcupine Abyssal Plain', 49.0, -16.5],
            ['33 NM south of 62163, Brittany shelf edge', 47.0, -8.47],
            ['46246 Ocean Station Papa', 49.903, -145.246],
        ];
        for (const [name, lat, lon] of outliers) {
            resetBuoyFeedCache();
            http.get.mockClear();
            const result = await findNearestWaveBuoy(lat, lon);
            expect(urlsFetched(), name).toContain(NDBC_LATEST_OBS_URL);
            expect(result.status === 'none' && result.covered, name).toBe(true);
        }
    });

    it('beyond 50 NM is none, even with a live buoy further out', async () => {
        // 62127 is ~39 NM from here: inside 50, outside a 20 NM ask.
        const result = await findNearestWaveBuoy(54.5, 0.0, { radiusNm: 20 });
        expect(result.status).toBe('none');
    });

    it('older than 3 h is none', async () => {
        vi.setSystemTime(NOW + BUOY_MAX_AGE_MS);
        const result = await findNearestWaveBuoy(-27.45, 153.55);
        expect(result.status).toBe('none');
    });

    it('a failed feed is said, not passed off as "no buoy"', async () => {
        serveFixtures({ [NDBC_LATEST_OBS_URL]: { status: 503, data: '' } });
        const result = await findNearestWaveBuoy(37.7, -122.75);
        expect(result).toEqual({
            status: 'none',
            radiusNm: 50,
            unreachable: [{ network: 'ndbc', name: 'NDBC', reason: 'failed' }],
            covered: true,
        });
        expect(describeNearestBuoy(result, METRIC, NOW)).toBe("Couldn't reach NDBC buoys just now");
    });

    it('web build: NDBC sends no CORS header, so it is not attempted and the line says why', async () => {
        http.native.value = false;
        const us = await findNearestWaveBuoy(37.7, -122.75);
        expect(urlsFetched()).not.toContain(NDBC_LATEST_OBS_URL);
        expect(describeNearestBuoy(us, METRIC, NOW)).toBe('NDBC buoys load in the app, not on the web');
        // Queensland and Ireland send CORS headers, so the web build still shows them.
        expect((await findNearestWaveBuoy(-27.45, 153.55)).status).toBe('found');
        expect((await findNearestWaveBuoy(51.3, -10.4)).status).toBe('found');
    });

    it('caches each feed for 10 minutes', async () => {
        await findNearestWaveBuoy(21.6, -158.2);
        await findNearestWaveBuoy(-14.2, -170.6);
        expect(urlsFetched().filter((u) => u === NDBC_LATEST_OBS_URL)).toHaveLength(1);
        vi.setSystemTime(NOW + BUOY_CACHE_TTL_MS + 1);
        await findNearestWaveBuoy(21.6, -158.2);
        expect(urlsFetched().filter((u) => u === NDBC_LATEST_OBS_URL)).toHaveLength(2);
    });

    it('wraps a world-copy longitude from the map back into range', async () => {
        const result = await findNearestWaveBuoy(21.6, -158.2 + 360);
        expect(result.status === 'found' && result.obs.key).toBe('ndbc:51201');
    });
});

describe('findNearestWaveBuoy — shore stations never take the second looks', () => {
    /** The untrimmed neighbourhood file, plus the spectral files of the buoys in it. */
    function serveNeighbourhoods(): void {
        serveFixtures({
            [NDBC_LATEST_OBS_URL]: { status: 200, data: NDBC_NEIGHBOURHOODS },
            ...Object.fromEntries(
                Object.entries(NDBC_SPEC).map(([id, body]) => [ndbcSpecUrl(id), { status: 200, data: body }]),
            ),
        });
    }
    const specsAsked = (): string[] => urlsFetched().filter((u) => u.includes('/5day2/'));

    it('Galveston: an airport and four tide gauges sit nearer than buoy 42035, and 42035 still answers', async () => {
        serveNeighbourhoods();
        // KGVW (FAA platform weather, 6.7 NM) and GTOT2/GNJT2/GRRT2 (NOS, 10–14 NM)
        // have no wave height and never will; 42035 (NDBC, 12.8 NM) is met-only at :30.
        const result = await findNearestWaveBuoy(29.2, -94.65);
        expect(describeNearestBuoy(result, METRIC, NOW)).toBe(
            'Measured 0.9 m · 6 s from ESE · NDBC 42035 · 13 NM · 25 min ago',
        );
        expect(specsAsked()).toEqual([ndbcSpecUrl('42035')]);
    });

    it('La Push, WA: two C-MAN stations nearer than 46041 do not hide it', async () => {
        serveNeighbourhoods();
        const result = await findNearestWaveBuoy(47.65, -124.74);
        expect(describeNearestBuoy(result, METRIC, NOW)).toBe(
            'Measured 1.4 m · 11 s from WNW · NDBC 46041 · 18 NM · 25 min ago',
        );
        expect(specsAsked()).not.toContain(ndbcSpecUrl('DESW1'));
        expect(specsAsked()).not.toContain(ndbcSpecUrl('LAPW1'));
    });

    it('Point Reyes: the second looks go to buoys 46013 and 46026, not Point Reyes and Bodega Bay gauges', async () => {
        serveNeighbourhoods();
        const result = await findNearestWaveBuoy(38.05, -123.04);
        // Without the second looks the answer would be 46214 at 21 NM.
        expect(describeNearestBuoy(result, METRIC, NOW)).toBe(
            'Measured 1.4 m · 13 s from SW · NDBC 46013 · 17 NM · 25 min ago',
        );
        expect([...specsAsked()].sort()).toEqual([ndbcSpecUrl('46013'), ndbcSpecUrl('46026')]);
    });
});

describe('describeNearestBuoy — the user’s units', () => {
    it('feet and statute miles', async () => {
        const result = await findNearestWaveBuoy(-27.45, 153.55);
        expect(describeNearestBuoy(result, { waveHeight: 'ft', distance: 'mi' }, NOW)).toBe(
            'Measured 8.0 ft · 9 s from SSE · Brisbane Mk4 (State of Queensland) · 6 mi · 1 h 35 min ago',
        );
    });

    it('kilometres for the radius too', async () => {
        const result = await findNearestWaveBuoy(53.8, -128.9);
        expect(describeNearestBuoy(result, { waveHeight: 'm', distance: 'km' }, NOW)).toBe(
            'No wave buoy reporting within 93 km',
        );
    });
});
