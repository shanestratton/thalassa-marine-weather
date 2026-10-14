/**
 * The sea in parts (build 130, 130-04): one marine call, MFWAM the only
 * number, GFS Wave a second opinion, and a snap guard per tapped point.
 *
 * Fixtures are trimmed real answers from the app's own proxy-openmeteo,
 * fetched 2026-10-14 06:10 and 07:25 UTC (tests/fixtures/sea-partitions,
 * credited in PROVENANCE.json): five seas, a lake, an island slope and one
 * berth, none of them a default.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchProxy } = vi.hoisted(() => ({ fetchProxy: vi.fn() }));
vi.mock('../services/weather/openMeteoProxy', () => ({ fetchOpenMeteoProxy: fetchProxy }));

import {
    SEA_CHECK_CREDIT,
    SEA_CREDIT,
    SEA_NONE_LONG,
    SEA_NONE_SHORT,
    SEA_SNAP_PAD,
    SEA_VARIABLES,
    clearSeaPartitionsCache,
    fetchSeaPartitions,
    guardSeaCell,
    parseSeaCell,
    seaDifferWords,
    seaHourAt,
    seaModelsDiffer,
    seaRequestParams,
} from '../services/weather/seaPartitions';

const fixture = (name: string) =>
    JSON.parse(readFileSync(`tests/fixtures/sea-partitions/${name}-2026-10-14.json`, 'utf8')) as Record<
        string,
        unknown
    >;
const at = (iso: string) => Date.parse(iso);

/** Where each fixture was asked for, and the hour its tests read. */
const SEAS = {
    gulf: { file: 'gulf-of-lion', lat: 43.0, lon: 4.5, now: at('2026-10-14T03:30:00Z') },
    northSea: { file: 'north-sea', lat: 53.5, lon: 3.0, now: at('2026-10-14T06:30:00Z') },
    northSeaSouth: { file: 'north-sea-south', lat: 53.48, lon: 3.02, now: at('2026-10-14T06:30:00Z') },
    tahiti: { file: 'tahiti-windward', lat: -17.55, lon: -149.05, now: at('2026-10-22T18:30:00Z') },
    caribbean: { file: 'anegada', lat: 18.9, lon: -64.3, now: at('2026-10-19T05:30:00Z') },
    whitsundays: { file: 'whitehaven', lat: -20.3, lon: 149.1, now: at('2026-10-14T06:30:00Z') },
    superior: { file: 'lake-superior', lat: 47.71, lon: -87.52, now: at('2026-10-14T06:30:00Z') },
    moorea: { file: 'moorea-slope', lat: -17.5, lon: -149.8, now: at('2026-10-22T18:30:00Z') },
    airlie: { file: 'airlie-beach', lat: -20.268, lon: 148.718, now: at('2026-10-14T06:30:00Z') },
} as const;

/** Answer each marine request with the fixture asked for at its point (as sent, four decimals). */
function answerByPoint(...keys: (keyof typeof SEAS)[]) {
    fetchProxy.mockImplementation((_operation: string, params: { latitude: string; longitude: string }) => {
        const key = keys.find(
            (k) => SEAS[k].lat.toFixed(4) === params.latitude && SEAS[k].lon.toFixed(4) === params.longitude,
        );
        return key
            ? Promise.resolve(fixture(SEAS[key].file))
            : Promise.reject(new Error(`no fixture for ${params.latitude}, ${params.longitude}`));
    });
}

function seaAt(key: keyof typeof SEAS) {
    const s = SEAS[key];
    return guardSeaCell(parseSeaCell(fixture(s.file), s.now), s.lat, s.lon);
}

beforeEach(() => {
    fetchProxy.mockReset();
    clearSeaPartitionsCache();
});

describe('the request', () => {
    const params = seaRequestParams(-33.86, 151.21);

    it('asks hourly only, never a `current` block (two models answer only the first, unsuffixed)', () => {
        expect(params).not.toHaveProperty('current');
        expect(String(params.hourly).split(',')).toEqual([...SEA_VARIABLES]);
    });

    it('never asks for secondary_swell_wave_peak_period: that one variable fails the whole request', () => {
        expect(SEA_VARIABLES as readonly string[]).not.toContain('secondary_swell_wave_peak_period');
        expect(String(params.hourly)).not.toContain('peak_period');
    });

    it('names MFWAM first (its cell is the one echoed), GFS Wave second, in unix time, for ten days', () => {
        expect(params.models).toBe('meteofrance_wave,ncep_gfswave025');
        expect(params.timeformat).toBe('unixtime');
        expect(params.forecast_days).toBe(10);
        expect(params.latitude).toBe('-33.8600');
    });

    it('asks only for what proxy-openmeteo already allows, so no deploy is needed', () => {
        const validation = readFileSync('supabase/functions/proxy-openmeteo/validation.ts', 'utf8');
        const marine = validation.slice(
            validation.indexOf('const MARINE_CURRENT'),
            validation.indexOf('const MARINE_HOURLY'),
        );
        for (const v of SEA_VARIABLES) expect(marine, v).toContain(`'${v}'`);
        const models = validation.slice(validation.indexOf('const MARINE_MODELS'));
        expect(models.slice(0, 200)).toContain("'meteofrance_wave'");
        expect(models.slice(0, 200)).toContain("'ncep_gfswave025'");
    });

    it('the pad is routeSeaSampler’s', () => {
        expect(readFileSync('services/routeSeaSampler.ts', 'utf8')).toContain(`const SEA_SNAP_PAD = ${SEA_SNAP_PAD};`);
    });
});

describe('parsing the suffixed hourly reply', () => {
    it('reads MFWAM’s parts under their suffixed keys, the hour picked by its epoch', () => {
        const sea = seaAt('gulf');
        expect(sea.local).toBe(true);
        expect(sea.hours).toHaveLength(24);
        const hour = seaHourAt(sea, SEAS.gulf.now)!;
        expect(new Date(hour.t).toISOString()).toBe('2026-10-14T03:00:00.000Z');
        expect(hour.total).toEqual({ hM: 0.82, periodS: 3.6, fromDeg: 330 });
        expect(hour.windSea).toEqual({ hM: 0.66, periodS: 3.05, fromDeg: 352 });
        expect(hour.swell?.fromDeg).not.toBeNull();
        expect(hour.swell2).not.toBeNull();
    });

    it('hours are unix seconds: the hour containing now, never one past the end', () => {
        const sea = seaAt('northSea');
        expect(seaHourAt(sea, at('2026-10-14T00:00:00Z'))?.t).toBe(at('2026-10-14T00:00:00Z'));
        expect(seaHourAt(sea, at('2026-10-14T23:59:00Z'))?.t).toBe(at('2026-10-14T23:00:00Z'));
        expect(seaHourAt(sea, at('2026-10-15T00:00:00Z'))).toBeNull();
        expect(seaHourAt(sea, at('2026-10-13T23:59:00Z'))).toBeNull();
    });

    it('MFWAM’s nulls stay nulls: past its 9-day horizon GFS Wave never stands in', () => {
        const sea = seaAt('tahiti');
        const before = seaHourAt(sea, at('2026-10-22T23:30:00Z'))!;
        expect(before.total?.hM).toBeGreaterThan(0);
        const after = seaHourAt(sea, at('2026-10-23T01:30:00Z'))!;
        expect(after.total).toBeNull();
        expect(after.windSea).toBeNull();
        expect(after.swell).toBeNull();
        expect(after.swell2).toBeNull();
        // GFS Wave still answered for that hour, and it is kept out of every number.
        expect(after.checkM).toBeGreaterThan(0);
        expect(seaModelsDiffer(after)).toBeNull();
    });

    it('a reply that is not one is a failure, not a shelter', () => {
        expect(() => parseSeaCell({ current: { wave_height: 1 } }, 0)).toThrow();
        expect(() => parseSeaCell(null, 0)).toThrow();
        const feet = { ...fixture('gulf-of-lion'), hourly_units: { wave_height_meteofrance_wave: 'ft' } };
        expect(() => parseSeaCell(feet, 0)).toThrow();
    });

    it('MFWAM’s own land mask (0 m, no period) is no sea, not a flat calm', () => {
        const masked = {
            latitude: 43.04,
            longitude: 4.46,
            hourly_units: { wave_height_meteofrance_wave: 'm' },
            hourly: { time: [1791936000], wave_height_meteofrance_wave: [0], wave_period_meteofrance_wave: [0] },
        };
        expect(parseSeaCell(masked, 0).hours[0].total).toBeNull();
    });
});

describe('GFS Wave: a second opinion, and its zeros are land-mask cells', () => {
    it('Airlie: every GFS partition is a literal 0, read as none (and the cell is refused anyway)', () => {
        const cell = parseSeaCell(fixture('airlie-beach'), 0);
        expect(cell.hours.every((h) => h.checkM === null)).toBe(true);
    });

    it('0 s or 0° beside a height is none too', () => {
        const reply = (period: number, dir: number) => ({
            latitude: 43.04,
            longitude: 4.46,
            hourly_units: { wave_height_meteofrance_wave: 'm' },
            hourly: {
                time: [1791936000],
                wave_height_meteofrance_wave: [0.8],
                wave_period_meteofrance_wave: [4],
                wave_height_ncep_gfswave025: [1.6],
                wave_period_ncep_gfswave025: [period],
                wave_direction_ncep_gfswave025: [dir],
            },
        });
        expect(parseSeaCell(reply(0, 200), 0).hours[0].checkM).toBeNull();
        expect(parseSeaCell(reply(6, 0), 0).hours[0].checkM).toBeNull();
        expect(parseSeaCell(reply(6, 200), 0).hours[0].checkM).toBe(1.6);
    });

    it('the Gulf of Lion: MFWAM 0.82 m, GFS Wave 1.3 m — models differ, said once, offshore', () => {
        const hour = seaHourAt(seaAt('gulf'), SEAS.gulf.now);
        expect(seaModelsDiffer(hour)).toEqual({ mfwamM: 0.82, gfsM: 1.3 });
    });

    it('needs both ×1.5 and 0.3 m', () => {
        const hour = (mf: number, gfs: number) => ({
            t: 0,
            total: { hM: mf, periodS: 5, fromDeg: 90 },
            windSea: null,
            swell: null,
            swell2: null,
            checkM: gfs,
        });
        expect(seaModelsDiffer(hour(0.4, 0.65))).toBeNull(); // ×1.6 but 0.25 m
        expect(seaModelsDiffer(hour(2.0, 2.9))).toBeNull(); // 0.9 m but ×1.45
        expect(seaModelsDiffer(hour(2.0, 3.0))).toEqual({ mfwamM: 2.0, gfsM: 3.0 });
        expect(seaModelsDiffer(hour(1.2, 0.8))).toEqual({ mfwamM: 1.2, gfsM: 0.8 });
    });

    it('the line credits NOAA beside GFS Wave’s number, in the caller’s unit', () => {
        expect(seaDifferWords({ mfwamM: 0.82, gfsM: 1.3 }, (m) => `${m.toFixed(1)} m`)).toBe(
            'Wave models differ: MFWAM 0.8 m, GFS Wave (NOAA) 1.3 m',
        );
    });

    it('a height under 0.1 m is "under 0.1 m" there too, never a 0.0 that reads as a measured calm', () => {
        const metres = (m: number) => `${m.toFixed(1)} m`;
        expect(seaDifferWords({ mfwamM: 0.04, gfsM: 0.4 }, metres)).toBe(
            'Wave models differ: MFWAM under 0.1 m, GFS Wave (NOAA) 0.4 m',
        );
        const feet = (m: number) => `${(m * 3.28084).toFixed(1)} ft`;
        expect(seaDifferWords({ mfwamM: 0.62, gfsM: 0.03 }, feet)).toBe(
            'Wave models differ: MFWAM 2.0 ft, GFS Wave (NOAA) under 0.3 ft',
        );
    });

    it('North Sea and Tahiti trades: no line where they agree', () => {
        expect(seaModelsDiffer(seaHourAt(seaAt('northSea'), SEAS.northSea.now))).toBeNull();
        expect(seaModelsDiffer(seaHourAt(seaAt('tahiti'), SEAS.tahiti.now))).toBeNull();
    });
});

describe('the snap guard, per tapped point', () => {
    it.each([
        ['gulf', 5.74],
        ['northSea', 5.39],
        ['northSeaSouth', 2.8],
        ['tahiti', 1.28],
        ['caribbean', 2.9],
        ['whitsundays', 2.77],
        ['superior', 1.63],
    ] as const)('%s: the cell %s km away is believed', (key, km) => {
        const sea = seaAt(key);
        expect(sea.snappedKm).toBeCloseTo(km, 0);
        expect(sea.local).toBe(true);
        expect(seaHourAt(sea, SEAS[key].now)?.total?.hM).toBeGreaterThan(0);
    });

    it('Airlie Beach: answered from a cell 17.7 km out — refused, no hours, never a number', () => {
        const sea = seaAt('airlie');
        expect(sea.snappedKm).toBeCloseTo(17.7, 0);
        expect(sea.local).toBe(false);
        expect(sea.hours).toEqual([]);
        expect(seaHourAt(sea, SEAS.airlie.now)).toBeNull();
    });

    it('an elevation is never read as land: Lake Superior is MFWAM water 181 m up, and an island slope sits in its cell', () => {
        // Open-Meteo's `elevation` is the 90 m terrain at the point asked. On
        // Lake Superior it is the lake's surface, and MFWAM answers from the
        // lake's own cell: an elevation rule would refuse the Great Lakes. So a
        // tap on Moorea's slope, 411 m up, is answered from the wet 1/12° cell it
        // lies in (the island is under the model's grid): the reply alone cannot
        // prove that slope dry.
        expect(fixture('lake-superior').elevation).toBe(181);
        expect(seaAt('superior').local).toBe(true);
        expect(seaHourAt(seaAt('superior'), SEAS.superior.now)?.total?.hM).toBeGreaterThan(0);
        expect(fixture('moorea-slope').elevation).toBe(411);
        expect(seaAt('moorea').snappedKm).toBeCloseTo(4.72, 1);
        expect(seaAt('moorea').local).toBe(true);
    });

    it('a reply that does not say where it came from is refused', () => {
        const { latitude: _lat, longitude: _lon, ...silent } = fixture('gulf-of-lion');
        const sea = guardSeaCell(parseSeaCell(silent, 0), 43, 4.5);
        expect(sea.snappedKm).toBeNull();
        expect(sea.local).toBe(false);
    });

    it('a second tap in the next MFWAM cell asks for its own, and is believed (a 0.05° bucket refused it)', async () => {
        // The southern North Sea, 2.4 km apart and one 0.05° bucket, but two
        // 1/12° cells. Measured against the first tap's cell centre the second
        // is 8.0 km off and would be refused; its own cell is 2.8 km off.
        answerByPoint('northSea', 'northSeaSouth');
        const first = await fetchSeaPartitions(53.5, 3.0, SEAS.northSea.now);
        const second = await fetchSeaPartitions(53.48, 3.02, SEAS.northSea.now);
        expect(fetchProxy).toHaveBeenCalledTimes(2);
        expect(fetchProxy.mock.calls[1]).toEqual(['marine', seaRequestParams(53.48, 3.02)]);
        expect(first.local).toBe(true);
        expect(second.gridLat).not.toBe(first.gridLat);
        expect(second.snappedKm).toBeCloseTo(2.8, 1);
        expect(second.local).toBe(true);
        expect(seaHourAt(second, SEAS.northSea.now)?.total?.hM).toBeGreaterThan(0);
    });

    it('a second tap in the same open-water cell is served from the cache, guarded for itself', async () => {
        answerByPoint('caribbean');
        const first = await fetchSeaPartitions(18.9, -64.3, SEAS.caribbean.now);
        const second = await fetchSeaPartitions(18.88, -64.31, SEAS.caribbean.now);
        expect(fetchProxy).toHaveBeenCalledTimes(1);
        expect(second.gridLat).toBe(first.gridLat);
        expect(second.snappedKm).not.toBe(first.snappedKm);
        expect(second.local).toBe(true);
    });

    it('a berth is refused only on a reply to its own point: a second tap in that dry cell asks for itself', async () => {
        // Airlie's cell is dry: MFWAM answers from 17.7 km out. A second tap in
        // the same cell is not refused on the first tap's reply (its own could
        // be a nearer wet cell); it asks, and is refused on its own answer.
        fetchProxy.mockImplementation(() => Promise.resolve(fixture('airlie-beach')));
        const now = SEAS.airlie.now;
        expect((await fetchSeaPartitions(-20.268, 148.718, now)).local).toBe(false);
        const second = await fetchSeaPartitions(-20.27, 148.72, now);
        expect(fetchProxy).toHaveBeenCalledTimes(2);
        expect(fetchProxy.mock.calls[1]).toEqual(['marine', seaRequestParams(-20.27, 148.72)]);
        expect(second.local).toBe(false);
        expect(second.hours).toEqual([]);
        // The same point again: its own reply is in the cache.
        expect((await fetchSeaPartitions(-20.27, 148.72, now)).local).toBe(false);
        expect(fetchProxy).toHaveBeenCalledTimes(2);
    });

    it('asks again an hour later, and after a failure', async () => {
        fetchProxy.mockRejectedValueOnce(new Error('down')).mockResolvedValue(fixture('gulf-of-lion'));
        const now = SEAS.gulf.now;
        await expect(fetchSeaPartitions(43, 4.5, now)).rejects.toThrow('down');
        await expect(fetchSeaPartitions(43, 4.5, now)).resolves.toMatchObject({ local: true });
        await fetchSeaPartitions(43, 4.5, now + 3_600_000);
        expect(fetchProxy).toHaveBeenCalledTimes(3);
        expect(fetchProxy.mock.calls[0]).toEqual(['marine', seaRequestParams(43, 4.5)]);
    });
});

describe('the cross sea and the words', () => {
    it('Anegada, Caribbean: a wind sea from the ENE across a northerly swell, each over 0.5 m', () => {
        const hour = seaHourAt(seaAt('caribbean'), SEAS.caribbean.now)!;
        expect(hour.windSea!.hM).toBeGreaterThanOrEqual(0.5);
        expect(hour.swell!.hM).toBeGreaterThanOrEqual(0.5);
        const apart = Math.abs(hour.windSea!.fromDeg! - hour.swell!.fromDeg!);
        expect(Math.min(apart, 360 - apart)).toBeGreaterThanOrEqual(45);
    });

    it('one module owns the no-sea words and the credits', () => {
        expect(SEA_NONE_LONG).toBe('No open-water wave model reaches here');
        expect(SEA_NONE_SHORT).toBe('No wave forecast here');
        expect(SEA_CREDIT).toBe('Waves: Météo-France MFWAM, E.U. Copernicus Marine (© Mercator Ocean) via Open-Meteo');
        expect(SEA_CHECK_CREDIT).toContain('NOAA');
        expect(seaAt('gulf').credit).toBe(SEA_CREDIT);
    });
});
