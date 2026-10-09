/**
 * The sounding in plain words (build 125, SND): each reading with its number,
 * in the skipper's units, one headline sentence, and no more certainty than
 * seven levels allow. Fictional profiles from the Caribbean trades, the North
 * Sea, off California, off southern Chile, the Baltic and off Bermuda, and the
 * hour picker over 72 h in the location's own time, clock changes included.
 *
 * The headline reads the whole column (review, 2026-10-09): a stable but
 * saturated frontal column is rain, not "settled"; falling 500 hPa heights
 * are a trough coming, not "settled"; freezing air under a warm nose is ice
 * on deck; and nothing assumes a coast or a sea breeze.
 */
import { describe, expect, it } from 'vitest';
import type { SoundingData } from '../services/weather/sounding/soundingData';
import {
    describeSounding,
    formatSoundingTime,
    formatUtcOffset,
    hourChoices,
    utcOffsetAt,
} from '../services/weather/sounding/soundingReadings';

const HOUR_MS = 3_600_000;
/** 2026-10-09 06:00 UTC. */
const T0 = Date.UTC(2026, 9, 9, 6);

interface LevelSpec {
    p: number;
    t: number;
    rh: number;
    z: number;
    kmh: number;
    dir: number;
}

function data(opts: {
    lat: number;
    lon: number;
    offsetH: number;
    surface: { t: number; td: number; mslp: number; cape: number | null };
    levels: LevelSpec[];
    /** 500 hPa height change per hour (m). */
    z500PerHour?: number;
    hours?: number;
    /** The IANA zone the answer names (none by default: the single offset then stands). */
    timezone?: string | null;
    /** The first hour (epoch ms); 2026-10-09 06:00 UTC by default. */
    t0?: number;
    /** Levels whose height the sync left out at every hour. */
    zMissing?: number[];
}): SoundingData {
    const hours = opts.hours ?? 76;
    const start = opts.t0 ?? T0;
    const times = Array.from({ length: hours }, (_, i) => start + i * HOUR_MS);
    const fill = <T>(v: T) => times.map(() => v);
    return {
        lat: opts.lat,
        lon: opts.lon,
        elevation: 0,
        utcOffsetSeconds: opts.offsetH * 3600,
        timezone: opts.timezone ?? null,
        times,
        surface: {
            t: fill(opts.surface.t),
            td: fill(opts.surface.td),
            mslp: fill(opts.surface.mslp),
            windKmh: fill(18),
            windFrom: fill(90),
            cape: fill(opts.surface.cape),
        },
        levels: opts.levels.map((l) => ({
            p: l.p,
            t: fill(l.t),
            rh: fill(l.rh),
            z: times.map((_, i) =>
                opts.zMissing?.includes(l.p) ? null : l.p === 500 ? l.z + (opts.z500PerHour ?? 0) * i : l.z,
            ),
            windKmh: fill(l.kmh),
            windFrom: fill(l.dir),
        })),
    };
}

/** RH that gives the wanted dewpoint by Magnus, so the profiles read naturally. */
const rhFor = (t: number, td: number) => 100 * Math.exp((17.625 * td) / (243.04 + td) - (17.625 * t) / (243.04 + t));

/** Off St Vincent in the trades (fictional): the trade lid at 925–850 hPa. */
const TRADES = data({
    lat: 13.5,
    lon: -61,
    offsetH: -4,
    surface: { t: 26, td: 21, mslp: 1013, cape: 50 },
    levels: [
        { p: 1000, t: 24.5, rh: rhFor(24.5, 20), z: 120, kmh: 30, dir: 85 },
        { p: 925, t: 20, rh: rhFor(20, 17), z: 790, kmh: 35, dir: 90 },
        { p: 850, t: 17.5, rh: rhFor(17.5, 4), z: 1530, kmh: 25, dir: 100 },
        { p: 700, t: 9, rh: rhFor(9, -8), z: 3160, kmh: 20, dir: 140 },
        { p: 500, t: -6, rh: rhFor(-6, -30), z: 5880, kmh: 30, dir: 250 },
        { p: 300, t: -32, rh: rhFor(-32, -55), z: 9650, kmh: 80, dir: 260 },
        { p: 250, t: -42, rh: rhFor(-42, -62), z: 10950, kmh: 129.6, dir: 245 },
    ],
    z500PerHour: 38 / 24,
});

/** Off Monterey, California (fictional): a strong subsidence inversion. */
const CALIFORNIA = data({
    lat: 36.5,
    lon: -122,
    offsetH: -7,
    surface: { t: 15, td: 12, mslp: 1016, cape: 0 },
    levels: [
        { p: 1000, t: 13.5, rh: rhFor(13.5, 11.5), z: 135, kmh: 20, dir: 310 },
        { p: 925, t: 21.5, rh: rhFor(21.5, 2), z: 800, kmh: 15, dir: 330 },
        { p: 850, t: 20, rh: rhFor(20, -5), z: 1520, kmh: 15, dir: 340 },
        { p: 700, t: 8, rh: rhFor(8, -15), z: 3140, kmh: 25, dir: 300 },
        { p: 500, t: -12, rh: rhFor(-12, -35), z: 5820, kmh: 40, dir: 280 },
        { p: 300, t: -38, rh: rhFor(-38, -50), z: 9500, kmh: 60, dir: 270 },
        { p: 250, t: -48, rh: rhFor(-48, -58), z: 10800, kmh: 70, dir: 270 },
    ],
    z500PerHour: -80 / 24,
});

/** North Sea, autumn gale (fictional): unstable, a deep trough coming. */
const NORTH_SEA = data({
    lat: 56,
    lon: 3,
    offsetH: 2,
    surface: { t: 11, td: 8, mslp: 992, cape: 650 },
    levels: [
        { p: 925, t: 5, rh: rhFor(5, 3), z: 620, kmh: 70, dir: 230 },
        { p: 850, t: 0, rh: rhFor(0, -2), z: 1280, kmh: 80, dir: 240 },
        { p: 700, t: -11, rh: rhFor(-11, -14), z: 2800, kmh: 90, dir: 245 },
        { p: 500, t: -30, rh: rhFor(-30, -34), z: 5310, kmh: 120, dir: 250 },
        { p: 300, t: -52, rh: rhFor(-52, -58), z: 8780, kmh: 170, dir: 255 },
        { p: 250, t: -55, rh: rhFor(-55, -62), z: 10010, kmh: 200, dir: 255 },
        // 1000 hPa sits under the 992 hPa surface: the model extrapolates it, the sounding drops it.
        { p: 1000, t: 12, rh: 80, z: -60, kmh: 60, dir: 220 },
    ].sort((a, b) => b.p - a.p),
    z500PerHour: -150 / 24,
});

const value = (report: ReturnType<typeof describeSounding>, key: string) =>
    report!.readings.find((r) => r.key === key)?.value;

describe('the trades (metric, knots)', () => {
    const report = describeSounding(TRADES, 0, { speed: 'kts', temp: 'C', length: 'm' });

    it('reads cloud base, freezing level and instability with their numbers', () => {
        expect(report).not.toBeNull();
        expect(value(report, 'cloudBase')).toBe('≈ 650 m');
        // 4,792 m by interpolation, shown to the nearest 50 m: seven levels allow no finer.
        expect(value(report, 'freezing')).toBe('4,800 m');
        expect(value(report, 'instability')).toBe('Stable (50 J/kg)');
    });

    it('names the trade lid in the tropics and says what it does', () => {
        expect(value(report, 'inversion')).toBe('Trade lid 0.8–1.5 km');
        expect(report!.headline).toBe(
            'Cloud base about 650 m. Tops capped near 1.5 km by the trade lid: flat cumulus, showers unlikely.',
        );
    });

    it('calls a 70 kt wind at 250 hPa a jet, in knots', () => {
        expect(value(report, 'jet')).toBe('70 kt from 245°');
    });

    it('gives the 500 hPa height and its 24 h trend', () => {
        expect(value(report, 'z500')).toBe('5,880 m, rising 38 m in 24 h (ridge building)');
    });

    it('keeps the surface first and every level above it', () => {
        expect(report!.profile.map((l) => l.p)).toEqual([1013, 1000, 925, 850, 700, 500, 300, 250]);
    });
});

describe('off California (°F, feet, mph)', () => {
    const report = describeSounding(CALIFORNIA, 0, { speed: 'mph', temp: 'F', length: 'ft' });

    it('reports the strongest inversion below 700 hPa in the skipper’s units, in words for anywhere', () => {
        expect(value(report, 'inversion')).toBe('14.4 °F warmer at 925 hPa');
        // No sea breeze: the same inversion caps air mid-ocean or over a winter fjord.
        expect(report!.headline).toBe(
            'Cloud base about 1,200 ft. A low inversion caps the air: any cloud stays flat and low.',
        );
    });

    it('labels the diagram’s cloud base in lower case, from the height itself', () => {
        expect(report!.cloudBaseLabel).toBe('cloud base ≈ 1,200 ft');
        // A sea fog off Monterey: T and Td within 0.1 °C.
        const fog = { ...CALIFORNIA, surface: { ...CALIFORNIA.surface, td: CALIFORNIA.times.map(() => 14.9) } };
        const foggy = describeSounding(fog, 0, { length: 'ft' });
        // Short enough to stay inside the plot on a 320 px screen (it is drawn at 12 px).
        expect(foggy!.cloudBaseLabel).toBe('cloud base: surface');
        expect(value(foggy, 'cloudBase')).toBe('Near the surface');
    });

    it('says when the wind aloft is no jet, in mph', () => {
        expect(value(report, 'jet')).toBe('None (43 mph)');
    });

    it('converts the heights to feet', () => {
        expect(value(report, 'cloudBase')).toBe('≈ 1,200 ft');
        expect(value(report, 'z500')).toBe('19,094 ft, falling 262 ft in 24 h (trough coming)');
    });
});

describe('a North Sea gale (unstable, km/h)', () => {
    const report = describeSounding(NORTH_SEA, 0, { speed: 'kmh', temp: 'C', length: 'm' });

    it('drops levels under the surface pressure', () => {
        expect(report!.profile.map((l) => l.p)).toEqual([992, 925, 850, 700, 500, 300, 250]);
    });

    it('leads with instability and names no trade lid this far from the tropics', () => {
        expect(value(report, 'instability')).toBe('Unstable (650 J/kg)');
        expect(report!.headline).toBe('Cloud base about 400 m. Unstable: showers can build.');
        expect(value(report, 'inversion')).not.toMatch(/trade/i);
        expect(value(report, 'jet')).toBe('200 km/h from 255°');
        expect(value(report, 'z500')).toBe('5,310 m, falling 150 m in 24 h (trough coming)');
    });

    it('says when CAPE is missing from the run rather than inventing it', () => {
        const noCape = { ...NORTH_SEA, surface: { ...NORTH_SEA.surface, cape: NORTH_SEA.times.map(() => null) } };
        expect(value(describeSounding(noCape, 0, {}), 'instability')).toBe('CAPE not in this run');
    });
});

/** RH from a T − Td spread, for saturated columns. */
const sat = (t: number, spread: number) => rhFor(t, t - spread);

/** North Sea warm front, autumn (fictional): stable, saturated to 500 hPa, a trough on its way. */
const NORTH_SEA_FRONT = data({
    lat: 57,
    lon: 2,
    offsetH: 1,
    surface: { t: 9, td: 8.6, mslp: 985, cape: 10 },
    levels: [
        { p: 1000, t: 10, rh: 99, z: -125, kmh: 70, dir: 160 },
        { p: 925, t: 6, rh: sat(6, 0.5), z: 520, kmh: 80, dir: 180 },
        { p: 850, t: 2.5, rh: sat(2.5, 0.5), z: 1180, kmh: 85, dir: 200 },
        { p: 700, t: -6, rh: sat(-6, 0.6), z: 2700, kmh: 90, dir: 220 },
        { p: 500, t: -24, rh: sat(-24, 0.8), z: 5050, kmh: 120, dir: 230 },
        { p: 300, t: -48, rh: sat(-48, 7), z: 8600, kmh: 160, dir: 240 },
        { p: 250, t: -55, rh: sat(-55, 7), z: 9800, kmh: 170, dir: 240 },
    ],
    z500PerHour: -160 / 24,
});

/** Off southern Chile, spring (fictional): the same stable, saturated frontal column south of the equator. */
const CHILE_FRONT = data({
    lat: -42.5,
    lon: -75.5,
    offsetH: -3,
    surface: { t: 10, td: 9.6, mslp: 990, cape: 5 },
    levels: [
        { p: 1000, t: 10.5, rh: 99, z: -80, kmh: 60, dir: 340 },
        { p: 925, t: 7, rh: sat(7, 0.6), z: 560, kmh: 75, dir: 330 },
        { p: 850, t: 3, rh: sat(3, 0.7), z: 1220, kmh: 80, dir: 320 },
        { p: 700, t: -5, rh: sat(-5, 1.2), z: 2740, kmh: 95, dir: 310 },
        { p: 500, t: -23, rh: sat(-23, 1.5), z: 5100, kmh: 120, dir: 300 },
        { p: 300, t: -47, rh: sat(-47, 8), z: 8650, kmh: 150, dir: 290 },
        { p: 250, t: -54, rh: sat(-54, 8), z: 9850, kmh: 160, dir: 290 },
    ],
    z500PerHour: -120 / 24,
});

/** The Baltic in January (fictional): −3 °C and saturated at the surface, a +1.5 °C warm nose at 925 hPa. */
const BALTIC_ICE = data({
    lat: 58.5,
    lon: 20,
    offsetH: 2,
    surface: { t: -3, td: -3.6, mslp: 1012, cape: 0 },
    levels: [
        { p: 1000, t: -2, rh: sat(-2, 0.5), z: 95, kmh: 30, dir: 170 },
        { p: 925, t: 1.5, rh: sat(1.5, 0.5), z: 720, kmh: 55, dir: 200 },
        { p: 850, t: -2, rh: sat(-2, 0.8), z: 1390, kmh: 60, dir: 220 },
        { p: 700, t: -9, rh: sat(-9, 1), z: 2900, kmh: 70, dir: 240 },
        { p: 500, t: -27, rh: sat(-27, 3), z: 5400, kmh: 100, dir: 250 },
        { p: 300, t: -50, rh: sat(-50, 6), z: 8900, kmh: 140, dir: 260 },
        { p: 250, t: -55, rh: sat(-55, 7), z: 10100, kmh: 150, dir: 260 },
    ],
});

/** Off Bermuda under a high (fictional): dry, cooling steadily with height, no lid, little CAPE. */
const BERMUDA_SPEC = {
    lat: 32.4,
    lon: -64.8,
    offsetH: -3,
    surface: { t: 18, td: 11, mslp: 1024, cape: 30 },
    levels: [
        { p: 1000, t: 17, rh: rhFor(17, 10.5), z: 200, kmh: 20, dir: 60 },
        { p: 925, t: 12, rh: rhFor(12, 6), z: 870, kmh: 25, dir: 70 },
        { p: 850, t: 6.5, rh: rhFor(6.5, -1), z: 1560, kmh: 25, dir: 90 },
        { p: 700, t: -3, rh: rhFor(-3, -14), z: 3130, kmh: 30, dir: 250 },
        { p: 500, t: -19, rh: rhFor(-19, -34), z: 5800, kmh: 45, dir: 260 },
        { p: 300, t: -43, rh: rhFor(-43, -55), z: 9500, kmh: 70, dir: 260 },
        { p: 250, t: -52, rh: rhFor(-52, -61), z: 10800, kmh: 80, dir: 260 },
    ],
};

function bermuda(z500PerHour: number, zMissing?: number[]) {
    return data({ ...BERMUDA_SPEC, z500PerHour, zMissing });
}

describe('the headline reads the whole column', () => {
    it('calls a stable, saturated North Sea front rain, not settled, with a trough coming', () => {
        const report = describeSounding(NORTH_SEA_FRONT, 0, { speed: 'kts', length: 'm' });
        expect(report!.headline).toBe(
            'Cloud base about 50 m. Moist through the column: layered cloud and rain likely, not showers.',
        );
        expect(report!.headline).not.toMatch(/settled/i);
        expect(value(report, 'z500')).toBe('5,050 m, falling 160 m in 24 h (trough coming)');
    });

    it('reads the same column the same way south of the equator', () => {
        const report = describeSounding(CHILE_FRONT, 0, { speed: 'kts', length: 'm' });
        expect(report!.headline).toBe(
            'Cloud base about 50 m. Moist through the column: layered cloud and rain likely, not showers.',
        );
        expect(value(report, 'inversion')).toBe('None below 700 hPa');
    });

    it('warns of rain freezing on deck under a warm nose, and names no sea breeze', () => {
        const report = describeSounding(BALTIC_ICE, 0, { speed: 'kts', temp: 'C', length: 'm' });
        expect(report!.headline).toBe(
            'Cloud base about 100 m. Freezing air under a warmer layer: rain can freeze on deck.',
        );
        expect(report!.headline).not.toMatch(/sea breeze/i);
        expect(value(report, 'freezing')).toBe('At the surface');
        expect(value(report, 'inversion')).toBe('3.5 °C warmer at 925 hPa');
    });

    it('says settled only for a dry, stable column whose heights hold', () => {
        expect(describeSounding(bermuda(0), 0, { length: 'm' })!.headline).toBe(
            'Cloud base about 900 m. Settled air, little to build cloud.',
        );
    });

    it('says a trough is coming, not settled, when the 500 hPa height falls more than 30 m in 24 h', () => {
        const report = describeSounding(bermuda(-60 / 24), 0, { length: 'm' });
        expect(report!.headline).toBe(
            'Cloud base about 900 m. Stable now, but heights are falling: a trough is coming.',
        );
        // 30 m or less is not a trend to speak of.
        expect(describeSounding(bermuda(-25 / 24), 0, { length: 'm' })!.headline).toMatch(/Settled air/);
    });
});

describe('missing data', () => {
    it('finds the freezing level across a height the sync left out', () => {
        // 6.5 °C at 850 hPa, −3 °C at 700 hPa: 0 °C at 2,634 m with every height,
        // 2,629 m with the 700 hPa height put back by the hypsometric equation.
        expect(value(describeSounding(bermuda(0), 0, { length: 'm' }), 'freezing')).toBe('2,650 m');
        expect(value(describeSounding(bermuda(0, [700]), 0, { length: 'm' }), 'freezing')).toBe('2,650 m');
    });

    it('says where the column stops when it ends below the freezing level', () => {
        const short = {
            ...TRADES,
            levels: TRADES.levels.map((l) => (l.p <= 500 ? { ...l, t: l.t.map(() => null) } : l)),
        };
        expect(value(describeSounding(short, 0, {}), 'freezing')).toBe('Above 700 hPa');
    });

    it('returns null when the surface or most levels are missing at that hour', () => {
        const gaps = {
            ...TRADES,
            levels: TRADES.levels.map((l, k) => (k < 5 ? { ...l, t: l.t.map(() => null) } : l)),
        };
        expect(describeSounding(gaps, 0, {})).toBeNull();
        const noSurface = { ...TRADES, surface: { ...TRADES.surface, t: TRADES.times.map(() => null) } };
        expect(describeSounding(noSurface, 0, {})).toBeNull();
    });

    it('looks back 24 h for the 500 hPa trend near the end of the run', () => {
        // 5,880 m rising 38 m a day: 5,994 m at +72 h, and no 24 h ahead to compare with.
        expect(value(describeSounding(TRADES, 72, { length: 'm' }), 'z500')).toBe(
            '5,994 m, rose 38 m over the past 24 h',
        );
    });
});

describe('the hour picker', () => {
    it('offers now, then every third local hour to 72 h ahead, in the location’s own time', () => {
        // 06:00 UTC is 02:00 at UTC−4: Now, 03:00, 06:00 … to 02:00 three days on.
        const choices = hourChoices(TRADES);
        expect(choices[0]).toEqual(expect.objectContaining({ index: 0, label: 'Now' }));
        expect(choices[1]).toEqual(expect.objectContaining({ index: 1, label: '03:00' }));
        expect(choices.length).toBe(25);
        expect(choices.at(-1)!.index).toBe(70);
        // A new day is named on its first chip.
        expect(choices.find((c) => c.index === 22)!.label).toBe('Sat 00:00');
    });

    it('uses the location’s offset, not the phone’s: UTC+2 in the North Sea', () => {
        const choices = hourChoices(NORTH_SEA);
        // 06:00 UTC is 08:00 at UTC+2.
        expect(choices[1]).toEqual(expect.objectContaining({ index: 1, label: '09:00' }));
    });
});

describe('the clocks change inside the 72 h', () => {
    /** Every chip after Now on a three-hour mark of the local clock. */
    const onTheGrid = (d: SoundingData) =>
        hourChoices(d)
            .slice(1)
            .every((c) => Number(formatSoundingTime(d, c.index).slice(-5, -3)) % 3 === 0);

    it('follows the English Channel back to GMT on Sunday 25 October', () => {
        // Fri 23 Oct 2026 12:00 UTC is 13:00 BST; the clocks go back at 01:00 UTC on the 25th.
        const channel = data({
            ...BERMUDA_SPEC,
            lat: 50,
            lon: -2,
            offsetH: 1,
            timezone: 'Europe/London',
            t0: Date.UTC(2026, 9, 23, 12),
        });
        expect(formatSoundingTime(channel, 0)).toBe('Fri 23 Oct, 13:00');
        expect(formatUtcOffset(utcOffsetAt(channel, 0))).toBe('UTC+1');
        // Sun 25 Oct 15:00 UTC, 51 h on, is 15:00 GMT, not 16:00.
        expect(formatSoundingTime(channel, 51)).toBe('Sun 25 Oct, 15:00');
        expect(formatUtcOffset(utcOffsetAt(channel, 51))).toBe('UTC');
        expect(hourChoices(channel).find((c) => c.index === 51)?.label).toBe('15:00');
        expect(onTheGrid(channel)).toBe(true);
    });

    it('follows the US east coast back to EST on Sunday 1 November', () => {
        // Fri 30 Oct 2026 16:00 UTC is 12:00 EDT; the clocks go back at 06:00 UTC on 1 Nov.
        const hatteras = data({
            ...BERMUDA_SPEC,
            lat: 35,
            lon: -75,
            offsetH: -4,
            timezone: 'America/New_York',
            t0: Date.UTC(2026, 9, 30, 16),
        });
        expect(formatSoundingTime(hatteras, 0)).toBe('Fri 30 Oct, 12:00');
        // Mon 2 Nov 12:00 UTC, 68 h on, is 07:00 EST.
        expect(formatSoundingTime(hatteras, 68)).toBe('Mon 2 Nov, 07:00');
        expect(formatUtcOffset(utcOffsetAt(hatteras, 68))).toBe('UTC−5');
        expect(onTheGrid(hatteras)).toBe(true);
    });

    it('keeps a half-hour zone’s minutes, and falls back to the single offset without a zone it knows', () => {
        // Off Mumbai: 06:00 UTC is 11:30 IST, so the first three-hour mark is 12:30.
        const mumbai = data({ ...BERMUDA_SPEC, lat: 19, lon: 72.5, offsetH: 5.5, timezone: 'Asia/Kolkata' });
        expect(hourChoices(mumbai)[1]).toEqual(expect.objectContaining({ index: 1, label: '12:30' }));
        expect(formatUtcOffset(utcOffsetAt(mumbai, 0))).toBe('UTC+5:30');
        const unknown = data({ ...BERMUDA_SPEC, lat: 19, lon: 72.5, offsetH: 5.5, timezone: 'Not/AZone' });
        expect(formatSoundingTime(unknown, 0)).toBe('Fri 9 Oct, 11:30');
        expect(utcOffsetAt(unknown, 0)).toBe(19_800);
    });
});
