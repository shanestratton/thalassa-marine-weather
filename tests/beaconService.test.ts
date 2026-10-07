/**
 * beaconService's wave-buoy readers (build 123, W1-11).
 *
 * The forecast merger takes a nearby buoy's reading as the measured value
 * (services/weather/api/stormglass.ts → mergeWeatherData). Before this fix:
 *   - the Queensland reader looked up the height under one column name while
 *     the live feed flips between `Hs` and `Hsig`, so on `Hsig` days every
 *     Queensland height read as undefined;
 *   - it stored the WAVE direction as the WIND direction, so the merged report
 *     showed the swell's bearing as the wind;
 *   - `-99.90` sentinels parsed as real numbers;
 *   - three of the six mapped site names no longer exist in the feed, and
 *     Double Island Point was mapped to Caloundra, 50 NM south of it;
 *   - the zoneless local DateTime was read as UTC (10 h out in Queensland);
 *   - the Irish reader asked a dataset that answers 404, with an unencoded
 *     query, and ignored which buoy it was asked for;
 *   - the NDBC reader keyed its timestamp on `YY` while the file's header says
 *     `#YY` (and the year has four digits), so no NDBC reading had a time.
 *
 * Fixtures are real public responses (tests/fixtures/buoys); rows marked
 * FICTIONAL exercise one rule each.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@capacitor/core', () => ({
    CapacitorHttp: { get: http.get },
    Capacitor: { isNativePlatform: () => true },
}));

const pi = vi.hoisted(() => ({
    passthroughJson: vi.fn(),
    passthroughText: vi.fn(),
}));
vi.mock('../services/PiCacheService', () => ({ piCache: pi }));

import { findAndFetchNearestBeacon } from '../services/weather/api/beaconService';
import { MAJOR_BUOYS } from '../services/weather/config';
import { resetBuoyFeedCache } from '../services/weather/buoys/feed';
import { QLD_WAVES_URL } from '../services/weather/buoys/providers/qldDes';
import { IRISH_MI_URL } from '../services/weather/buoys/providers/irishMI';

const fixture = (name: string): string =>
    fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/buoys', name), 'utf8');
const QLD_LISTS = JSON.parse(fixture('qld-des-ckan-latest-2026-10-07T1705Z.json'));
const QLD_HSIG = JSON.parse(fixture('qld-des-ckan-hsig-objects-2026-10-07T0440Z.json'));
const IRISH = JSON.parse(fixture('irish-mi-iwbnetwork-latest-2026-10-07T1700Z.json'));

const NOW = Date.UTC(2026, 9, 7, 17, 5);

const at = (id: string) => {
    const b = MAJOR_BUOYS.find((x) => x.id === id);
    if (!b) throw new Error(`no buoy ${id} in MAJOR_BUOYS`);
    return b;
};
const beaconAt = (id: string) => findAndFetchNearestBeacon(at(id).lat, at(id).lon, 1);

function serve(bodies: Record<string, unknown>): void {
    http.get.mockImplementation(async ({ url }: { url: string }) =>
        url in bodies ? { status: 200, data: bodies[url] } : { status: 404, data: '' },
    );
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    http.get.mockReset();
    pi.passthroughJson.mockReset().mockResolvedValue(null);
    pi.passthroughText.mockReset().mockResolvedValue(null);
    resetBuoyFeedCache();
    serve({ [QLD_WAVES_URL]: QLD_LISTS, [IRISH_MI_URL]: IRISH });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('Queensland wave buoys', () => {
    it('every mapped buoy finds its LIVE site (three of six never matched)', async () => {
        const expected: Record<string, number> = {
            Moreton: 2.44, // Brisbane Mk4
            MB_Cent: 1.179, // North Moreton Bay
            Spitfire: 1.179, // North Moreton Bay
            Mooloolaba: 1.854,
            GoldCoast: 1.2, // Gold Coast Mk4
            Byron: 2.47, // Tweed Offshore
            DoubleIsland: 2.068, // Wide Bay, 10 NM off the point (not Caloundra, 50 NM south)
            // Unmapped until 2026-10-08: each read nothing with a live site a few miles off.
            Stradbroke: 2.44, // Brisbane Mk4, ~6 NM
            Townsville: 0.282, // ~18 NM
            Cairns: 0.22, // Cairns Mk4, ~12 NM
            Gladstone: 0.422, // ~13 NM
        };
        for (const [id, hs] of Object.entries(expected)) {
            const obs = await beaconAt(id);
            expect(obs?.waveHeight, id).toBe(hs);
        }
    });

    it('names the buoy that actually measured it, where it actually is', async () => {
        const obs = await beaconAt('Byron');
        expect(obs?.name).toBe('Tweed Offshore (State of Queensland)');
        expect(obs?.lat).toBeCloseTo(-28.21373, 5);
        // Cape Byron to the Tweed Offshore buoy, measured, not the 0 NM of the lookup.
        expect(obs?.distance).toBeGreaterThan(20);
    });

    it('keeps the WAVE direction out of the WIND direction', async () => {
        const obs = await beaconAt('Moreton');
        expect(obs?.windDirection).toBeUndefined();
        expect(obs?.swellDirection).toBe(161.26);
        expect(obs?.swellPeriod).toBe(8.7);
    });

    it('times the reading from the Seconds epoch, not the zoneless local DateTime', async () => {
        const obs = await beaconAt('Moreton');
        expect(obs?.timestamp).toBe('2026-10-07T15:30:00.000Z');
    });

    it('reads the height under Hsig as well as Hs', async () => {
        vi.setSystemTime(Date.UTC(2026, 9, 7, 4, 40));
        serve({ [QLD_WAVES_URL]: QLD_HSIG });
        const obs = await beaconAt('Moreton');
        expect(obs?.waveHeight).toBe(2.52);
    });

    it('a -99.90 sentinel is no reading (FICTIONAL row)', async () => {
        serve({
            [QLD_WAVES_URL]: {
                success: true,
                result: {
                    records: [
                        {
                            Site: 'Mooloolaba',
                            SiteNumber: '4',
                            Seconds: String(NOW / 1000 - 1800),
                            DateTime: '2026-10-08T02:35:00',
                            Latitude: '-26.56611',
                            Longitude: '153.18102',
                            Hs: '1.500',
                            Tp: '-99.90',
                            SST: '-99.90',
                            Direction: '-99.90',
                        },
                    ],
                },
            },
        });
        const obs = await beaconAt('Mooloolaba');
        expect(obs?.waveHeight).toBe(1.5);
        expect(obs?.swellPeriod).toBeUndefined();
        expect(obs?.waterTemperature).toBeUndefined();
        expect(obs?.swellDirection).toBeUndefined();
    });

    it('a reading older than 3 h is not passed off as current', async () => {
        vi.setSystemTime(NOW + 3 * 3600_000);
        expect(await beaconAt('Moreton')).toBeNull();
    });
});

describe('Irish Marine Institute buoys (IWBNetwork)', () => {
    it('M3 reads its own row from the live dataset', async () => {
        const obs = await beaconAt('M3');
        expect(obs).toMatchObject({ waveHeight: 2.695, swellPeriod: 11.133, swellDirection: 319 });
        expect(obs?.timestamp).toBe('2026-10-07T16:00:00.000Z');
        expect(urlsAsked()).toContain(IRISH_MI_URL);
    });

    it('M4, off station today, is null rather than another buoy’s reading', async () => {
        expect(await beaconAt('M4')).toBeNull();
    });

    it('never stands in a buoy beyond 50 NM: the M5 entry is at Belmullet, the live M5 ~200 NM away', async () => {
        expect(await beaconAt('M5')).toBeNull();
    });
});

describe('NDBC realtime2 reader', () => {
    it('times the reading from the #YY header and a four-digit year, and takes waves from the newest wave row', async () => {
        // Real head of realtime2/46026.txt, 2026-10-07: the met-only :30 row
        // leads, the wave row is ten minutes older.
        pi.passthroughText.mockResolvedValue(
            [
                '#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE',
                '#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft',
                '2026 10 07 16 30 330  5.0  6.0    MM    MM    MM  MM 1013.6    MM  15.9    MM   MM   MM    MM',
                '2026 10 07 16 20 330  4.0  5.0   1.3    13   6.6 270 1013.6    MM  15.8    MM   MM   MM    MM',
            ].join('\n'),
        );
        const obs = await beaconAt('46026');
        expect(obs?.timestamp).toBe('2026-10-07T16:30:00.000Z');
        expect(obs?.windSpeed).toBe(5);
        expect(obs?.waveHeight).toBe(1.3);
        expect(obs?.swellPeriod).toBe(13);
    });

    it('a station that stopped reporting days ago is not merged as current', async () => {
        // Real head of realtime2/41002.txt (South Hatteras) as served on
        // 2026-10-07 17:46 UTC: its newest row is from 3 October.
        pi.passthroughText.mockResolvedValue(
            [
                '#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE',
                '#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft',
                '2026 10 03 16 50  90  1.0  2.0   0.8    11   6.6  78 1020.5  27.6  28.4  22.9   MM   MM    MM',
                '2026 10 03 16 40  MM  0.0  1.0    MM    MM    MM  MM 1020.5  27.6  28.4  22.8   MM   MM    MM',
                '2026 10 03 16 30  90  1.0  2.0    MM    MM    MM  MM 1020.5  27.3  28.4  22.8   MM   MM    MM',
            ].join('\n'),
        );
        expect(await beaconAt('41002')).toBeNull();
    });

    it('waves hours older than the stamped row are left out, not passed off as current (FICTIONAL rows)', async () => {
        // An hourly station (46012's layout) whose wave sensor has been down
        // for six hours: the met rows are current, the last wave row is not.
        const hourly = [16, 15, 14, 13, 12, 11].map(
            (hh) => `2026 10 07 ${hh} 00 330  6.0  7.0    MM    MM    MM  MM 1013.8  14.0  16.5  13.9   MM +0.6    MM`,
        );
        pi.passthroughText.mockResolvedValue(
            [
                '#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE',
                '#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft',
                ...hourly,
                '2026 10 07 10 00 330  6.0  7.0   2.9    12   8.0 300 1013.8  14.0  16.5  13.9   MM +0.6    MM',
            ].join('\n'),
        );
        const obs = await beaconAt('46012');
        expect(obs?.timestamp).toBe('2026-10-07T16:00:00.000Z');
        expect(obs?.windSpeed).toBe(6);
        expect(obs?.waveHeight).toBeUndefined();
        expect(obs?.swellPeriod).toBeUndefined();
        expect(obs?.swellDirection).toBeUndefined();
    });
});

function urlsAsked(): string[] {
    return [
        ...http.get.mock.calls.map(([req]) => (req as { url: string }).url),
        ...pi.passthroughJson.mock.calls.map(([url]) => url as string),
    ];
}
