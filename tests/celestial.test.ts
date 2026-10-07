import { afterEach, describe, it, expect, vi } from 'vitest';
import SunCalc from 'suncalc';
import { readFileSync } from 'node:fs';
import { getMoonPhaseData } from '../components/dashboard/tide/CelestialComponents';
import {
    getFirstLight,
    getLastLight,
    getMoonData,
    getSolarTimes,
    getSolarTimesForDate,
    localNoon,
    moonlightByNight,
    MOON_STAYS_UP,
    NO_TRUE_NIGHT,
    startOfLocalDay,
    SUN_STAYS_DOWN,
    SUN_STAYS_UP,
} from '../utils/celestial';
import { buildReportFromWeatherKit } from '../services/weather/api/weatherkit';
import { computeSunPhase } from '../components/dashboard/hero/heroSlideHelpers';
import { generateTacticalAdvice } from '../utils/advisory';
import type { ForecastDay, SourcedWeatherMetrics, WeatherMetrics } from '../types';

describe('CelestialComponents — getMoonPhaseData', () => {
    // ── Basic output structure ──────────────────────────────────

    it('returns phaseName, illumination, and phaseRatio', () => {
        const result = getMoonPhaseData(new Date());
        expect(result).toHaveProperty('phaseName');
        expect(result).toHaveProperty('illumination');
        expect(result).toHaveProperty('phaseRatio');
    });

    it('phaseRatio is between 0 and 1', () => {
        const result = getMoonPhaseData(new Date());
        expect(result.phaseRatio).toBeGreaterThanOrEqual(0);
        expect(result.phaseRatio).toBeLessThan(1);
    });

    it('illumination is between 0 and 1', () => {
        const result = getMoonPhaseData(new Date());
        expect(result.illumination).toBeGreaterThanOrEqual(0);
        expect(result.illumination).toBeLessThanOrEqual(1);
    });

    // ── Known moon phases ──────────────────────────────────────

    it('known new moon returns ~0 illumination', () => {
        // Jan 6, 2000 12:24 UTC was a known new moon
        const result = getMoonPhaseData(new Date('2000-01-06T12:24:00Z'));
        expect(result.illumination).toBeLessThan(0.05);
        expect(result.phaseName).toBe('New Moon');
    });

    it('~14.76 days after new moon is full moon', () => {
        // Half a synodic month (~14.76 days) after known new moon
        const newMoon = new Date('2000-01-06T12:24:00Z');
        const fullMoon = new Date(newMoon.getTime() + 14.765 * 24 * 60 * 60 * 1000);
        const result = getMoonPhaseData(fullMoon);
        expect(result.illumination).toBeGreaterThan(0.95);
        expect(result.phaseName).toBe('Full Moon');
    });

    it('~7.4 days after new moon is first quarter', () => {
        const newMoon = new Date('2000-01-06T12:24:00Z');
        const firstQ = new Date(newMoon.getTime() + 7.38 * 24 * 60 * 60 * 1000);
        const result = getMoonPhaseData(firstQ);
        expect(result.illumination).toBeGreaterThan(0.4);
        expect(result.illumination).toBeLessThan(0.6);
        expect(result.phaseName).toBe('First Quarter');
    });

    it('~22.15 days after new moon is last quarter', () => {
        const newMoon = new Date('2000-01-06T12:24:00Z');
        const lastQ = new Date(newMoon.getTime() + 22.15 * 24 * 60 * 60 * 1000);
        const result = getMoonPhaseData(lastQ);
        expect(result.illumination).toBeGreaterThan(0.4);
        expect(result.illumination).toBeLessThan(0.6);
        expect(result.phaseName).toBe('Last Quarter');
    });

    // ── Determinism ─────────────────────────────────────────────

    it('same date always produces same result', () => {
        const date = new Date('2026-03-15T12:00:00Z');
        const r1 = getMoonPhaseData(date);
        const r2 = getMoonPhaseData(date);
        expect(r1).toEqual(r2);
    });

    // ── Phase name coverage ──────────────────────────────────

    it('covers all 8 phase names across a full cycle', () => {
        const phases = new Set<string>();
        const newMoon = new Date('2000-01-06T12:24:00Z');
        for (let d = 0; d < 30; d++) {
            const date = new Date(newMoon.getTime() + d * 24 * 60 * 60 * 1000);
            phases.add(getMoonPhaseData(date).phaseName);
        }
        expect(phases.size).toBe(8);
        expect(phases.has('New Moon')).toBe(true);
        expect(phases.has('Waxing Crescent')).toBe(true);
        expect(phases.has('First Quarter')).toBe(true);
        expect(phases.has('Waxing Gibbous')).toBe(true);
        expect(phases.has('Full Moon')).toBe(true);
        expect(phases.has('Waning Gibbous')).toBe(true);
        expect(phases.has('Last Quarter')).toBe(true);
        expect(phases.has('Waning Crescent')).toBe(true);
    });

    // ── Edge cases ──────────────────────────────────────────────

    it('handles date before known epoch', () => {
        const result = getMoonPhaseData(new Date('1990-01-01T00:00:00Z'));
        expect(result.phaseRatio).toBeGreaterThanOrEqual(0);
        expect(result.phaseRatio).toBeLessThan(1);
        expect(result.phaseName.length).toBeGreaterThan(0);
    });

    it('handles far future date', () => {
        const result = getMoonPhaseData(new Date('2100-06-15T00:00:00Z'));
        expect(result.phaseRatio).toBeGreaterThanOrEqual(0);
        expect(result.phaseRatio).toBeLessThan(1);
    });
});

// ════════════════════════════════════════════════════════════════════
// Twilight and moon truth (build 123, W1-06)
//
// Every time below is checked against the US Naval Observatory almanac:
// USNO Astronomical Applications API v4.0.1, rstt/oneday, fetched 2026-10-07
//   https://aa.usno.navy.mil/api/rstt/oneday?date=<date>&coords=<lat>,<lon>&tz=<offset>
// USNO prints times rounded to the minute in the zone offset given; the
// offset used is noted beside each place. "dawn"/"dusk" are USNO's Begin /
// End Civil Twilight (sun 6° below the horizon).
//
// Run this file under three phone zones — the bugs were phone-zone bugs:
//   TZ=Australia/Brisbane    npx vitest run tests/celestial.test.ts
//   TZ=America/Los_Angeles   npx vitest run tests/celestial.test.ts
//   TZ=Europe/Paris          npx vitest run tests/celestial.test.ts
// ════════════════════════════════════════════════════════════════════

interface AlmanacDay {
    place: string;
    lat: number;
    lon: number;
    tz: string;
    /** The place's own calendar date. */
    date: string;
    /** 12:00 on that date, on the place's own clock. */
    noon: string;
    /** USNO's printed civil twilight and sunrise/sunset, local clock. */
    sun: { dawn: string; rise: string; set: string; dusk: string };
    /** USNO's printed moonrise/moonset, local clock. */
    moon: { rise: string; set: string };
}

const ALMANAC: AlmanacDay[] = [
    // tz=2 (CEST)
    {
        place: 'Marseille',
        lat: 43.3,
        lon: 5.37,
        tz: 'Europe/Paris',
        date: '2026-10-07',
        noon: '2026-10-07T12:00:00+02:00',
        sun: { dawn: '07:14', rise: '07:43', set: '19:09', dusk: '19:38' },
        moon: { rise: '03:58', set: '17:38' },
    },
    // tz=-4 (AST)
    {
        place: 'Philipsburg, Sint Maarten',
        lat: 18.03,
        lon: -63.08,
        tz: 'America/Lower_Princes',
        date: '2026-10-07',
        noon: '2026-10-07T12:00:00-04:00',
        sun: { dawn: '05:42', rise: '06:04', set: '17:56', dusk: '18:18' },
        moon: { rise: '03:13', set: '15:59' },
    },
    // tz=12 (FJT)
    {
        place: 'Suva, Fiji',
        lat: -18.14,
        lon: 178.42,
        tz: 'Pacific/Fiji',
        date: '2026-10-07',
        noon: '2026-10-07T12:00:00+12:00',
        sun: { dawn: '05:22', rise: '05:44', set: '18:05', dusk: '18:27' },
        moon: { rise: '03:08', set: '14:56' },
    },
    // tz=2 (SAST)
    {
        place: 'Cape Town',
        lat: -33.92,
        lon: 18.42,
        tz: 'Africa/Johannesburg',
        date: '2026-10-07',
        noon: '2026-10-07T12:00:00+02:00',
        sun: { dawn: '05:50', rise: '06:15', set: '18:54', dusk: '19:19' },
        moon: { rise: '04:23', set: '15:48' },
    },
    // tz=10 (AEST)
    {
        place: 'Airlie Beach, Whitsundays',
        lat: -20.27,
        lon: 148.72,
        tz: 'Australia/Brisbane',
        date: '2026-10-07',
        noon: '2026-10-07T12:00:00+10:00',
        sun: { dawn: '05:19', rise: '05:42', set: '18:05', dusk: '18:27' },
        moon: { rise: '03:13', set: '14:57' },
    },
    // tz=10 (AEST)
    {
        place: 'Newport, Moreton Bay',
        lat: -27.21,
        lon: 153.09,
        tz: 'Australia/Brisbane',
        date: '2026-10-07',
        noon: '2026-10-07T12:00:00+10:00',
        sun: { dawn: '04:57', rise: '05:21', set: '17:51', dusk: '18:14' },
        moon: { rise: '03:03', set: '14:32' },
    },
    // tz=2 (CEST)
    {
        place: 'Tromsø',
        lat: 69.65,
        lon: 18.96,
        tz: 'Europe/Oslo',
        date: '2026-10-07',
        noon: '2026-10-07T12:00:00+02:00',
        sun: { dawn: '06:22', rise: '07:22', set: '17:40', dusk: '18:40' },
        moon: { rise: '01:21', set: '17:43' },
    },
    // tz=2 (CEST)
    {
        place: 'Tromsø',
        lat: 69.65,
        lon: 18.96,
        tz: 'Europe/Oslo',
        date: '2026-10-08',
        noon: '2026-10-08T12:00:00+02:00',
        sun: { dawn: '06:26', rise: '07:26', set: '17:35', dusk: '18:35' },
        moon: { rise: '03:33', set: '17:18' },
    },
];

/**
 * Sun times stay SunCalc's (today's correct results must not move), and
 * SunCalc solves the hour angle with the noon declination: measured worst
 * vs USNO is 2 min below 45° and 5 min at Tromsø near the equinox.
 */
const sunTolerance = (lat: number) => (Math.abs(lat) > 60 ? 5 : 3);
/** Moon rise/set use the Astronomical Almanac low-precision lunar series
 *  with parallax: measured worst vs USNO is 2 min on every fixture here
 *  (SunCalc's own moon was 8 min off at Marseille and 29 min at Tromsø). */
const MOON_TOLERANCE = 2;

/** Signed minutes from `expected` to `actual`, both "HH:MM", wrapped. */
function minutesApart(actual: string | undefined, expected: string): number {
    if (!actual || !/^\d{2}:\d{2}$/.test(actual)) return Number.POSITIVE_INFINITY;
    const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
    let d = toMin(actual) - toMin(expected);
    if (d > 720) d -= 1440;
    if (d < -720) d += 1440;
    return Math.abs(d);
}

/**
 * Run `fn` on a phone set to `tz`. Node re-reads process.env.TZ when it is
 * assigned, so CI (UTC, no TZ set) still exercises the phone-zone bugs: a
 * revert to the phone's "date + T12:00:00" noon passes under UTC for most
 * places and fails on a Brisbane phone.
 */
function onPhoneClock<T>(tz: string, fn: () => T): T {
    const was = process.env.TZ;
    process.env.TZ = tz;
    try {
        return fn();
    } finally {
        if (was === undefined) delete process.env.TZ;
        else process.env.TZ = was;
    }
}
/** Phone zones far east and west of the places tested, and Greenwich. */
const PHONE_ZONES = ['Australia/Brisbane', 'America/Los_Angeles', 'UTC', 'Pacific/Kiritimati'];

/** "HH:MM" of an instant on a zone's clock. */
function clockIn(d: Date | null | undefined, tz: string): string {
    if (!d) return 'none';
    return d.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
}

describe('celestial — the location’s own day, checked against USNO', () => {
    for (const day of ALMANAC) {
        // Local noon of the place's own date: in a Brisbane or Los Angeles
        // phone zone this instant falls on a different calendar day.
        const noon = new Date(day.noon);

        it(`${day.place} ${day.date}: sunrise, sunset and civil twilight`, () => {
            const s = getSolarTimes(noon, day.lat, day.lon, day.tz);
            const tol = sunTolerance(day.lat);
            expect(minutesApart(s.dawn, day.sun.dawn)).toBeLessThanOrEqual(tol);
            expect(minutesApart(s.sunrise, day.sun.rise)).toBeLessThanOrEqual(tol);
            expect(minutesApart(s.sunset, day.sun.set)).toBeLessThanOrEqual(tol);
            expect(minutesApart(s.dusk, day.sun.dusk)).toBeLessThanOrEqual(tol);
        });

        it(`${day.place} ${day.date}: moonrise and moonset of that day`, () => {
            const m = getMoonData(noon, day.lat, day.lon, day.tz);
            expect({ rise: m.moonrise, set: m.moonset }).toSatisfy(
                (got: { rise?: string; set?: string }) =>
                    minutesApart(got.rise, day.moon.rise) <= MOON_TOLERANCE &&
                    minutesApart(got.set, day.moon.set) <= MOON_TOLERANCE,
                `within ${MOON_TOLERANCE} min of USNO rise ${day.moon.rise}, set ${day.moon.set}`,
            );
            expect(m.moonState).toBe('normal');
            // The structured instants say the same thing as the strings.
            expect(clockIn(m.moonriseAt, day.tz)).toBe(m.moonrise);
            expect(clockIn(m.moonsetAt, day.tz)).toBe(m.moonset);
        });
    }

    it('a phone on another clock still gets Marseille’s moonset for Marseille’s day', () => {
        // 10:00 UTC = 12:00 in Marseille, 20:00 in Brisbane, 03:00 in Los
        // Angeles. SunCalc counted from the PHONE's midnight, so a Brisbane
        // phone was handed the 6 Oct moonset (USNO 17:15) and a Los Angeles
        // phone the 8 Oct moonrise (USNO 05:11).
        for (const phone of PHONE_ZONES) {
            const m = onPhoneClock(phone, () =>
                getMoonData(new Date('2026-10-07T10:00:00Z'), 43.3, 5.37, 'Europe/Paris'),
            );
            expect(minutesApart(m.moonset, '17:38'), phone).toBeLessThanOrEqual(MOON_TOLERANCE);
            expect(minutesApart(m.moonrise, '03:58'), phone).toBeLessThanOrEqual(MOON_TOLERANCE);
        }
    });

    it('just after local midnight, the sun times are for the new local day', () => {
        // 22:15 UTC on 7 Oct is 00:15 on 8 Oct in Tromsø. The nearest solar
        // noon is still 7 Oct's, which SunCalc used: sunrise 07:22, not 8
        // Oct's 07:26 (USNO).
        const s = getSolarTimes(new Date('2026-10-07T22:15:00Z'), 69.65, 18.96, 'Europe/Oslo');
        expect(minutesApart(s.sunrise, '07:26')).toBeLessThanOrEqual(2);
    });

    for (const phone of PHONE_ZONES) {
        it(`a forecast row’s date is the location’s date on a ${phone} phone`, () => {
            // Juneau, Alaska (UTC-8, USNO tz=-8). Read on a Brisbane phone, the
            // old "date + T12:00:00" noon was 6 Oct in Juneau: 07:14 / 18:19.
            // USNO for 7 Oct: rise 07:16, set 18:14.
            const s = onPhoneClock(phone, () => getSolarTimesForDate('2026-10-07', 58.3, -134.42, 'America/Juneau'));
            const direct = SunCalc.getTimes(new Date('2026-10-07T12:00:00-08:00'), 58.3, -134.42);
            expect(s.sunrise).toBe(clockIn(direct.sunrise, 'America/Juneau'));
            expect(s.sunset).toBe(clockIn(direct.sunset, 'America/Juneau'));
            expect(minutesApart(s.sunrise, '07:16')).toBeLessThanOrEqual(3);
            expect(minutesApart(s.sunset, '18:14')).toBeLessThanOrEqual(3);
        });
    }

    it('the phone clock really is switched under the test (guards the guard)', () => {
        const at = new Date('2026-10-07T00:00:00Z');
        expect(onPhoneClock('Australia/Brisbane', () => at.getHours())).toBe(10);
        expect(onPhoneClock('America/Los_Angeles', () => at.getHours())).toBe(17);
    });
});

describe('celestial — results that were already right do not move', () => {
    /** The pre-W1-06 formatter: SunCalc at the instant, HH:MM in the zone. */
    function legacySolar(at: Date, lat: number, lon: number, tz: string) {
        const t = SunCalc.getTimes(at, lat, lon);
        return {
            sunrise: clockIn(t.sunrise, tz),
            sunset: clockIn(t.sunset, tz),
            dawn: clockIn(t.dawn, tz),
            dusk: clockIn(t.dusk, tz),
            nauticalDawn: clockIn(t.nauticalDawn, tz),
            nauticalDusk: clockIn(t.nauticalDusk, tz),
            goldenHourStart: clockIn(t.goldenHour, tz),
            goldenHourEnd: clockIn(t.goldenHourEnd, tz),
            solarNoon: clockIn(t.solarNoon, tz),
        };
    }

    const cases: [string, number, number, string, string][] = [
        ['Newport morning', -27.21, 153.09, 'Australia/Brisbane', '2026-10-07T06:00:00+10:00'],
        ['Newport noon', -27.21, 153.09, 'Australia/Brisbane', '2026-10-07T12:00:00+10:00'],
        ['Newport evening', -27.21, 153.09, 'Australia/Brisbane', '2026-10-07T20:00:00+10:00'],
        ['Marseille afternoon', 43.3, 5.37, 'Europe/Paris', '2026-10-07T15:00:00+02:00'],
        ['Cape Town morning', -33.92, 18.42, 'Africa/Johannesburg', '2026-10-07T07:30:00+02:00'],
        ['Sint Maarten evening', 18.03, -63.08, 'America/Lower_Princes', '2026-10-07T21:00:00-04:00'],
    ];
    for (const [name, lat, lon, tz, iso] of cases) {
        it(`${name}: every HH:MM field is what it was`, () => {
            const at = new Date(iso);
            expect(getSolarTimes(at, lat, lon, tz)).toEqual(legacySolar(at, lat, lon, tz));
        });
    }

    it('moon phase and illumination are still SunCalc’s', () => {
        const at = new Date('2026-10-07T10:00:00Z');
        const m = getMoonData(at, 43.3, 5.37, 'Europe/Paris');
        const ill = SunCalc.getMoonIllumination(at);
        expect(m.illumination).toBe(ill.fraction);
        expect(m.phaseRatio).toBe(ill.phase);
        // USNO: 12% illuminated, waning crescent, on 7 Oct.
        expect(Math.round(m.illumination * 100)).toBeGreaterThanOrEqual(10);
        expect(Math.round(m.illumination * 100)).toBeLessThanOrEqual(13);
        expect(m.phaseName).toBe('Waning Crescent');
    });
});

describe('celestial — honest high-latitude states instead of --:--', () => {
    it('Tromsø midsummer: the sun stays up and there is no true night', () => {
        // USNO 2026-06-21 (tz=2): "Object continuously above the Horizon",
        // "continuously above the Twilight Limit". Moon: set 00:37, rise 12:18.
        const noon = new Date('2026-06-21T12:00:00+02:00');
        const s = getSolarTimes(noon, 69.65, 18.96, 'Europe/Oslo');
        expect(s.sunrise).toBe(SUN_STAYS_UP);
        expect(s.sunset).toBe(SUN_STAYS_UP);
        expect(s.dawn).toBe(NO_TRUE_NIGHT);
        expect(s.dusk).toBe(NO_TRUE_NIGHT);
        expect(s.nauticalDawn).toBe(NO_TRUE_NIGHT);
        expect(s.nauticalDusk).toBe(NO_TRUE_NIGHT);
        expect(getFirstLight(noon, 69.65, 18.96, 'Europe/Oslo')).toEqual({ at: null, state: 'no-true-night' });
        expect(getLastLight(noon, 69.65, 18.96, 'Europe/Oslo')).toEqual({ at: null, state: 'no-true-night' });
        const m = getMoonData(noon, 69.65, 18.96, 'Europe/Oslo');
        expect(minutesApart(m.moonset, '00:37')).toBeLessThanOrEqual(MOON_TOLERANCE);
        expect(minutesApart(m.moonrise, '12:18')).toBeLessThanOrEqual(MOON_TOLERANCE);
    });

    it('Tromsø midwinter: the sun stays down, civil twilight still comes, the moon stays up', () => {
        // USNO 2026-12-21 (tz=1): "Object continuously below the Horizon",
        // Begin Civil Twilight 09:31, End Civil Twilight 13:53; Moon:
        // "Object continuously above the Horizon", 90% illuminated.
        const noon = new Date('2026-12-21T12:00:00+01:00');
        const s = getSolarTimes(noon, 69.65, 18.96, 'Europe/Oslo');
        expect(s.sunrise).toBe(SUN_STAYS_DOWN);
        expect(s.sunset).toBe(SUN_STAYS_DOWN);
        expect(minutesApart(s.dawn, '09:31')).toBeLessThanOrEqual(5);
        expect(minutesApart(s.dusk, '13:53')).toBeLessThanOrEqual(5);
        const first = getFirstLight(noon, 69.65, 18.96, 'Europe/Oslo');
        expect(first.state).toBe('normal');
        expect(minutesApart(clockIn(first.at, 'Europe/Oslo'), '09:31')).toBeLessThanOrEqual(5);
        const m = getMoonData(noon, 69.65, 18.96, 'Europe/Oslo');
        expect(m.moonState).toBe('always-up');
        expect(m.moonrise).toBe(MOON_STAYS_UP);
        expect(m.moonset).toBe(MOON_STAYS_UP);
        expect(m.moonriseAt).toBeUndefined();
        expect(m.moonsetAt).toBeUndefined();
    });

    it('Tromsø in May: the sun rises and sets but civil twilight never ends', () => {
        // USNO 2026-05-10 (tz=2): "continuously above the Twilight Limit",
        // Rise 02:25, Set 23:02. Moon: rise 04:24, set 10:32.
        const noon = new Date('2026-05-10T12:00:00+02:00');
        const s = getSolarTimes(noon, 69.65, 18.96, 'Europe/Oslo');
        expect(minutesApart(s.sunrise, '02:25')).toBeLessThanOrEqual(5);
        expect(minutesApart(s.sunset, '23:02')).toBeLessThanOrEqual(5);
        expect(s.dawn).toBe(NO_TRUE_NIGHT);
        expect(s.dusk).toBe(NO_TRUE_NIGHT);
        expect(getLastLight(noon, 69.65, 18.96, 'Europe/Oslo')).toEqual({ at: null, state: 'no-true-night' });
        const m = getMoonData(noon, 69.65, 18.96, 'Europe/Oslo');
        expect(minutesApart(m.moonrise, '04:24')).toBeLessThanOrEqual(MOON_TOLERANCE);
        expect(minutesApart(m.moonset, '10:32')).toBeLessThanOrEqual(MOON_TOLERANCE);
    });

    it('Copenhagen and Ushuaia at their midsummers: nautical twilight lasts all night', () => {
        // No USNO figure for nautical twilight; this is geometry. At the
        // solstice the sun's lowest point is 90° − |lat| − 23.44° below the
        // horizon: Copenhagen 10.9°, Ushuaia 11.8° — never the 12° that ends
        // nautical twilight, while civil dusk (6°) still comes.
        const cph = getSolarTimes(new Date('2026-06-21T12:00:00+02:00'), 55.68, 12.57, 'Europe/Copenhagen');
        expect(cph.nauticalDusk).toBe(NO_TRUE_NIGHT);
        expect(cph.nauticalDawn).toBe(NO_TRUE_NIGHT);
        expect(cph.dusk).toMatch(/^\d{2}:\d{2}$/);
        const ush = getSolarTimes(new Date('2026-12-21T12:00:00-03:00'), -54.8, -68.3, 'America/Argentina/Ushuaia');
        expect(ush.nauticalDusk).toBe(NO_TRUE_NIGHT);
        expect(ush.dusk).toMatch(/^\d{2}:\d{2}$/);
        const nautical = getLastLight(
            new Date('2026-06-21T12:00:00+02:00'),
            55.68,
            12.57,
            'Europe/Copenhagen',
            'nautical',
        );
        expect(nautical).toEqual({ at: null, state: 'no-true-night' });
    });

    it('Longyearbyen in December: not even civil twilight', () => {
        // The sun peaks 11.7° below the horizon (90 − 78.22 − 23.44).
        const noon = new Date('2026-12-21T12:00:00+01:00');
        const s = getSolarTimes(noon, 78.22, 15.65, 'Arctic/Longyearbyen');
        expect(s.sunrise).toBe(SUN_STAYS_DOWN);
        expect(s.dawn).toBe(SUN_STAYS_DOWN);
        expect(s.dusk).toBe(SUN_STAYS_DOWN);
        expect(s.nauticalDawn).toMatch(/^\d{2}:\d{2}$/);
        expect(getFirstLight(noon, 78.22, 15.65, 'Arctic/Longyearbyen')).toEqual({ at: null, state: 'stays-dark' });
    });
});

describe('celestial — structured first and last light', () => {
    it('returns the civil dawn and dusk instants at an ordinary latitude', () => {
        const noon = new Date('2026-10-07T12:00:00+10:00');
        const first = getFirstLight(noon, -27.21, 153.09, 'Australia/Brisbane');
        const last = getLastLight(noon, -27.21, 153.09, 'Australia/Brisbane');
        expect(first.state).toBe('normal');
        expect(last.state).toBe('normal');
        // USNO Newport 7 Oct: civil twilight 04:57 → 18:14.
        expect(minutesApart(clockIn(first.at, 'Australia/Brisbane'), '04:57')).toBeLessThanOrEqual(3);
        expect(minutesApart(clockIn(last.at, 'Australia/Brisbane'), '18:14')).toBeLessThanOrEqual(3);
    });

    it('nautical first light comes before civil first light', () => {
        const noon = new Date('2026-10-07T12:00:00+02:00');
        const civil = getFirstLight(noon, -33.92, 18.42, 'Africa/Johannesburg', 'civil');
        const nautical = getFirstLight(noon, -33.92, 18.42, 'Africa/Johannesburg', 'nautical');
        expect(nautical.at!.getTime()).toBeLessThan(civil.at!.getTime());
    });
});

describe('celestial — location-day clock helpers', () => {
    it('localNoon is 12:00 on the place’s own clock', () => {
        expect(localNoon('2026-10-07', 'Pacific/Fiji').toISOString()).toBe('2026-10-07T00:00:00.000Z');
        expect(localNoon('2026-10-07', 'America/Lower_Princes').toISOString()).toBe('2026-10-07T16:00:00.000Z');
        // A Date picks the place's calendar day containing that instant:
        // 20:00 UTC on 6 Oct is already 7 Oct in Fiji.
        expect(localNoon(new Date('2026-10-06T20:00:00Z'), 'Pacific/Fiji').toISOString()).toBe(
            '2026-10-07T00:00:00.000Z',
        );
    });

    it('startOfLocalDay handles daylight-saving days', () => {
        expect(startOfLocalDay(new Date('2026-10-07T10:00:00Z'), 'Europe/Paris').toISOString()).toBe(
            '2026-10-06T22:00:00.000Z',
        );
        // Paris falls back on 25 Oct 2026: midnight is still CEST (+2).
        expect(startOfLocalDay(new Date('2026-10-25T15:00:00Z'), 'Europe/Paris').toISOString()).toBe(
            '2026-10-24T22:00:00.000Z',
        );
        // Chile springs forward AT midnight on 6 Sep 2026: 00:00 never
        // happens, so the day starts at 01:00 (-03).
        expect(startOfLocalDay(new Date('2026-09-06T15:00:00Z'), 'America/Santiago').toISOString()).toBe(
            '2026-09-06T04:00:00.000Z',
        );
    });
});

describe('celestial — moonlight per night', () => {
    it('a thin waning moon gives a dark night (Marseille, 7–8 Oct 2026)', () => {
        // USNO: civil dusk 19:38 on 7 Oct, civil dawn 07:15 on 8 Oct (11.6 h
        // dark); moonset 17:38 before dark, moonrise 05:11 → up 2.1 h of
        // it; 6% illuminated on 8 Oct.
        const nights = moonlightByNight(
            Date.parse('2026-10-07T12:00:00+02:00'),
            Date.parse('2026-10-08T12:00:00+02:00'),
            () => ({ lat: 43.3, lon: 5.37 }),
        );
        expect(nights).toHaveLength(1);
        const n = nights[0];
        expect(n.darkHours).toBeGreaterThan(11.4);
        expect(n.darkHours).toBeLessThan(11.8);
        expect(n.moonUpHours).toBeGreaterThan(1.9);
        expect(n.moonUpHours).toBeLessThan(2.3);
        expect(n.illumination).toBeGreaterThan(0.04);
        expect(n.illumination).toBeLessThan(0.1);
        expect(n.moonlightHours).toBeCloseTo(n.illumination * n.moonUpHours, 1);
        expect(n.moonlightHours).toBeLessThan(0.25);
    });

    it('a full moon lights the whole night (Sint Maarten, 25–26 Oct 2026)', () => {
        // USNO: civil dusk 18:06, civil dawn 05:47 (11.7 h dark); moonrise
        // 17:16 before dark, moonset 06:27 after dawn; full moon 26 Oct
        // 00:12 local, 100% illuminated.
        const nights = moonlightByNight(
            Date.parse('2026-10-25T12:00:00-04:00'),
            Date.parse('2026-10-26T12:00:00-04:00'),
            () => ({ lat: 18.03, lon: -63.08 }),
        );
        expect(nights).toHaveLength(1);
        const n = nights[0];
        expect(n.darkHours).toBeGreaterThan(11.5);
        expect(n.darkHours).toBeLessThan(11.9);
        expect(n.moonUpHours).toBeCloseTo(n.darkHours, 5);
        expect(n.illumination).toBeGreaterThan(0.97);
        expect(n.moonlightHours).toBeGreaterThan(11.2);
    });

    it('no darkness, no nights (Tromsø, midsummer)', () => {
        const nights = moonlightByNight(
            Date.parse('2026-06-20T12:00:00+02:00'),
            Date.parse('2026-06-23T12:00:00+02:00'),
            () => ({ lat: 69.65, lon: 18.96 }),
        );
        expect(nights).toEqual([]);
    });
});

describe('WeatherKit report — twilight fields for the location’s own day', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    const row = (isoDate: string): ForecastDay => ({
        day: 'Thu',
        date: isoDate,
        isoDate,
        highTemp: 8,
        lowTemp: 3,
        windSpeed: 12,
        waveHeight: null,
        condition: 'Cloudy',
    });

    it('just after Tromsø midnight, “today” is the new local day', () => {
        // 22:15 UTC 7 Oct = 00:15 8 Oct in Tromsø. USNO 8 Oct (tz=2): sunrise
        // 07:26, civil twilight 06:26 → 18:35, moonrise 03:33, moonset 17:18.
        vi.useFakeTimers({ now: new Date('2026-10-07T22:15:00Z'), toFake: ['Date'] });
        const report = buildReportFromWeatherKit(
            { observation: null, hourly: [], daily: [row('2026-10-08')], minutelyRain: [], rainSummary: '' },
            69.65,
            18.96,
            'Tromsø',
        );
        expect(report.timeZone).toBe('Europe/Oslo');
        expect(minutesApart(report.current.sunrise, '07:26')).toBeLessThanOrEqual(2);
        expect(minutesApart(report.current.dawn, '06:26')).toBeLessThanOrEqual(5);
        expect(minutesApart(report.current.moonrise, '03:33')).toBeLessThanOrEqual(MOON_TOLERANCE);
        expect(minutesApart(report.current.moonset, '17:18')).toBeLessThanOrEqual(MOON_TOLERANCE);
        expect(report.forecast[0].sunrise).toBe(report.current.sunrise);
    });

    for (const phone of PHONE_ZONES) {
        it(`a Juneau forecast row carries Juneau’s 7 Oct on a ${phone} phone`, () => {
            vi.useFakeTimers({ now: new Date('2026-10-07T20:00:00Z'), toFake: ['Date'] });
            const report = onPhoneClock(phone, () =>
                buildReportFromWeatherKit(
                    { observation: null, hourly: [], daily: [row('2026-10-07')], minutelyRain: [], rainSummary: '' },
                    58.3,
                    -134.42,
                    'Juneau',
                ),
            );
            const direct = SunCalc.getTimes(new Date('2026-10-07T12:00:00-08:00'), 58.3, -134.42);
            expect(report.forecast[0].sunrise).toBe(clockIn(direct.sunrise, 'America/Juneau'));
            expect(report.forecast[0].sunset).toBe(clockIn(direct.sunset, 'America/Juneau'));
        });
    }

    it('in the polar night the current fields say so', () => {
        vi.useFakeTimers({ now: new Date('2026-12-21T11:00:00Z'), toFake: ['Date'] });
        const report = buildReportFromWeatherKit(
            { observation: null, hourly: [], daily: [row('2026-12-21')], minutelyRain: [], rainSummary: '' },
            69.65,
            18.96,
            'Tromsø',
        );
        expect(report.current.sunrise).toBe(SUN_STAYS_DOWN);
        expect(report.current.sunset).toBe(SUN_STAYS_DOWN);
        expect(report.current.moonrise).toBe(MOON_STAYS_UP);
        expect(report.forecast[0].sunrise).toBe(SUN_STAYS_DOWN);
    });
});

describe('the polar words reach the readers that parse sunrise and sunset', () => {
    // These readers parse "HH:MM". Without a guard "Sun stays up" parsed to
    // 0:undefined → an Invalid Date → night all day, and the advice read
    // "Sunset at Sun stays up".
    const card = (sunrise: string, sunset: string) => ({ sunrise, sunset }) as unknown as SourcedWeatherMetrics;

    it('the hero card is day under the midnight sun and night in the polar night', () => {
        const midnight = Date.parse('2026-06-21T22:00:00Z');
        expect(computeSunPhase(card(SUN_STAYS_UP, SUN_STAYS_UP), midnight).isDay).toBe(true);
        const noon = Date.parse('2026-12-21T11:00:00Z');
        expect(computeSunPhase(card(SUN_STAYS_DOWN, SUN_STAYS_DOWN), noon).isDay).toBe(false);
    });

    it('the Glass page reads day and night with the hero card’s reader, polar words included', () => {
        // Dashboard's isActiveDay had its own HH:MM parser, which read 'Sun
        // stays up' as night. It now asks computeSunPhase (tested above).
        const src = readFileSync('components/Dashboard.tsx', 'utf8');
        expect(src).toContain('computeSunPhase(safeActive, widgetCardTime).isDay');
    });

    it('the tactical advice says the sun stays up or down instead of a bogus sunset', () => {
        const metrics = { windSpeed: 8, waveHeight: 1, condition: 'Clear' } as unknown as WeatherMetrics;
        const up = generateTacticalAdvice(metrics, false, 'Tromsø', undefined, [], SUN_STAYS_UP);
        expect(up).toContain('the sun stays up all day');
        expect(up).not.toContain('Sunset at');
        const down = generateTacticalAdvice(metrics, false, 'Tromsø', undefined, [], SUN_STAYS_DOWN);
        expect(down).toContain('the sun stays down all day');
        expect(down).not.toContain('Sunset at');
    });
});
