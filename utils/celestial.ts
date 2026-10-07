/**
 * celestial.ts — Offline astronomical calculations via SunCalc.
 *
 * Provides sunrise/sunset, dawn/dusk, golden hour, moon phase, moonrise/moonset,
 * and moon position — all computed mathematically from date + GPS coordinates.
 *
 * Zero API calls. Works 500 miles offshore with no cell reception.
 *
 * THE LOCATION'S OWN DAY (build 123, W1-06). Pass the location's IANA zone
 * and every "today" here is the location's calendar day on the location's
 * clock — not the phone's. SunCalc's moon search counted 24 h from the
 * PHONE's midnight, so a Brisbane phone looking at Marseille was handed the
 * previous day's moonset. Results that were already right (phone zone =
 * location zone) do not change: the sun times are SunCalc's, anchored to the
 * same solar day.
 *
 * HONEST HIGH LATITUDES. Where an event never happens that day the field
 * says why ("Sun stays up", "Sun stays down", "No true night") instead of
 * '--:--', and the structured helpers return the instant plus a state.
 */
import SunCalc from 'suncalc';

const RAD = Math.PI / 180;
const HOUR_MS = 3_600_000;

/** Words for events that do not happen on that day. */
export const SUN_STAYS_UP = 'Sun stays up';
export const SUN_STAYS_DOWN = 'Sun stays down';
/** The sun never sinks far enough for that twilight to end: light all night. */
export const NO_TRUE_NIGHT = 'No true night';
export const MOON_STAYS_UP = 'Moon stays up';
export const MOON_STAYS_DOWN = 'Moon stays down';

// ── Helpers ──────────────────────────────────────────────────────

/** Format a Date to HH:MM, optionally in a target IANA timezone */
function toHHMM(d: Date, timeZone?: string): string {
    if (isNaN(d.getTime())) return '--:--';
    if (!timeZone) {
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    try {
        return d.toLocaleTimeString('en-GB', {
            timeZone,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });
    } catch {
        // Fallback to device local time if timezone string is invalid
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
}

/** Determine human-readable phase name from 0–1 SunCalc phase value */
function phaseNameFromValue(phase: number): string {
    if (phase < 0.03 || phase > 0.97) return 'New Moon';
    if (phase < 0.22) return 'Waxing Crescent';
    if (phase < 0.28) return 'First Quarter';
    if (phase < 0.47) return 'Waxing Gibbous';
    if (phase < 0.53) return 'Full Moon';
    if (phase < 0.72) return 'Waning Gibbous';
    if (phase < 0.78) return 'Last Quarter';
    return 'Waning Crescent';
}

// ── The location's clock ─────────────────────────────────────────

const zoneFormats = new Map<string, Intl.DateTimeFormat | null>();

/** A cached formatter for a real IANA zone; null for none or an invalid one
 *  (which then reads the phone's clock, as toHHMM does). */
function zoneFormat(tz?: string): Intl.DateTimeFormat | null {
    if (!tz) return null;
    let f = zoneFormats.get(tz);
    if (f === undefined) {
        try {
            f = new Intl.DateTimeFormat('en-US', {
                timeZone: tz,
                hourCycle: 'h23',
                year: 'numeric',
                month: 'numeric',
                day: 'numeric',
                hour: 'numeric',
                minute: 'numeric',
                second: 'numeric',
            });
        } catch {
            f = null;
        }
        zoneFormats.set(tz, f);
    }
    return f;
}

/** Wall-clock [year, month, day, hour, minute, second] of an instant in `tz`. */
function wallClock(ms: number, tz?: string): number[] {
    const f = zoneFormat(tz);
    // An invalid date stays invalid (formatToParts would throw on it).
    if (!Number.isFinite(ms)) return [NaN, NaN, NaN, NaN, NaN, NaN];
    if (!f) {
        const d = new Date(ms);
        return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
    }
    const p: Record<string, number> = {};
    for (const part of f.formatToParts(ms)) p[part.type] = Number(part.value);
    return [p.year, p.month, p.day, p.hour % 24, p.minute, p.second];
}

/** The instant a wall-clock hour on a calendar day occurs in `tz`. Where the
 *  hour does not exist (a daylight-saving jump), the first instant after it. */
function wallToInstant(y: number, mo: number, d: number, h: number, tz?: string): number {
    if (!zoneFormat(tz)) return new Date(y, mo - 1, d, h).getTime();
    const target = Date.UTC(y, mo - 1, d, h);
    const offset = (ms: number) => {
        const w = wallClock(ms, tz);
        return Date.UTC(w[0], w[1] - 1, w[2], w[3], w[4], w[5]) - Math.floor(ms / 1000) * 1000;
    };
    const first = target - offset(target);
    const second = target - offset(first);
    // Keep a candidate that lands on the asked-for date (Chile's midnight
    // jump leaves 23:00 the day before as the other one).
    const onDay = (ms: number) => {
        const w = wallClock(ms, tz);
        return w[0] === y && w[1] === mo && w[2] === d;
    };
    if (onDay(second)) return second;
    return onDay(first) ? first : Math.max(first, second);
}

function calendarDay(day: Date | string, tz?: string): number[] {
    if (typeof day === 'string') return day.slice(0, 10).split('-').map(Number);
    return wallClock(day.getTime(), tz);
}

/** 12:00 on the location's clock, on a 'YYYY-MM-DD' date or on the
 *  location's calendar day containing an instant. */
export function localNoon(day: Date | string, tz?: string): Date {
    const [y, m, d] = calendarDay(day, tz);
    return new Date(wallToInstant(y, m, d, 12, tz));
}

/** The first instant of the location's calendar day containing `date`. */
export function startOfLocalDay(date: Date, tz?: string): Date {
    const [y, m, d] = calendarDay(date, tz);
    return new Date(wallToInstant(y, m, d, 0, tz));
}

// ── Solar Times ──────────────────────────────────────────────────

export interface SolarTimes {
    sunrise: string; // HH:MM, or SUN_STAYS_UP / SUN_STAYS_DOWN
    sunset: string; // HH:MM, or SUN_STAYS_UP / SUN_STAYS_DOWN
    dawn: string; // HH:MM — civil twilight start, or NO_TRUE_NIGHT / SUN_STAYS_DOWN
    dusk: string; // HH:MM — civil twilight end, or NO_TRUE_NIGHT / SUN_STAYS_DOWN
    nauticalDawn: string; // HH:MM, or NO_TRUE_NIGHT / SUN_STAYS_DOWN
    nauticalDusk: string; // HH:MM, or NO_TRUE_NIGHT / SUN_STAYS_DOWN
    goldenHourStart: string; // HH:MM — evening golden hour starts
    goldenHourEnd: string; // HH:MM — morning golden hour ends
    solarNoon: string; // HH:MM
}

/** SunCalc's times for the location's day: with a zone, anchored at the
 *  location's local noon; without one, the solar day nearest `date`. */
function sunTimes(date: Date, lat: number, lon: number, tz?: string) {
    const times = SunCalc.getTimes(tz ? localNoon(date, tz) : date, lat, lon);
    // The sun's highest point that day decides why an event is missing:
    // below the line all day, or above it all day.
    const peak = SunCalc.getPosition(times.solarNoon, lat, lon).altitude / RAD;
    return { times, peak };
}

/**
 * Compute all solar event times for a given date and location.
 * @param date  An instant on the target day (the location's day when `tz` is given)
 * @param lat   Latitude
 * @param lon   Longitude
 * @param tz    Optional IANA timezone (e.g. "Australia/Brisbane")
 */
export function getSolarTimes(date: Date, lat: number, lon: number, tz?: string): SolarTimes {
    const { times, peak } = sunTimes(date, lat, lon, tz);
    // An invalid date leaves the peak NaN too: that stays '--:--'.
    const at = (d: Date, line: number, above: string) =>
        isNaN(d.getTime()) && !isNaN(peak) ? (peak < line ? SUN_STAYS_DOWN : above) : toHHMM(d, tz);
    return {
        sunrise: at(times.sunrise, -0.833, SUN_STAYS_UP),
        sunset: at(times.sunset, -0.833, SUN_STAYS_UP),
        dawn: at(times.dawn, -6, NO_TRUE_NIGHT),
        dusk: at(times.dusk, -6, NO_TRUE_NIGHT),
        nauticalDawn: at(times.nauticalDawn, -12, NO_TRUE_NIGHT),
        nauticalDusk: at(times.nauticalDusk, -12, NO_TRUE_NIGHT),
        goldenHourStart: toHHMM(times.goldenHour, tz), // evening golden hour start
        goldenHourEnd: toHHMM(times.goldenHourEnd, tz), // morning golden hour end
        solarNoon: toHHMM(times.solarNoon, tz),
    };
}

/** Solar times for a forecast row's 'YYYY-MM-DD' — the location's date. */
export function getSolarTimesForDate(isoDate: string, lat: number, lon: number, tz?: string): SolarTimes {
    return getSolarTimes(localNoon(isoDate, tz), lat, lon, tz);
}

// ── First and last light (structured) ────────────────────────────

export type TwilightKind = 'civil' | 'nautical' | 'astronomical';
/** 'normal': the event happens. 'no-true-night': the sun never sinks below
 *  that twilight line. 'stays-dark': it never climbs above it. */
export type LightState = 'normal' | 'no-true-night' | 'stays-dark';
export interface LightTime {
    at: Date | null;
    state: LightState;
}

const TWILIGHT: Record<
    TwilightKind,
    [number, 'dawn' | 'nauticalDawn' | 'nightEnd', 'dusk' | 'nauticalDusk' | 'night']
> = {
    civil: [-6, 'dawn', 'dusk'],
    nautical: [-12, 'nauticalDawn', 'nauticalDusk'],
    astronomical: [-18, 'nightEnd', 'night'],
};

function lightTime(
    dusk: boolean,
    date: Date,
    lat: number,
    lon: number,
    tz?: string,
    kind: TwilightKind = 'civil',
): LightTime {
    const [line, dawnKey, duskKey] = TWILIGHT[kind];
    const { times, peak } = sunTimes(date, lat, lon, tz);
    const at = times[dusk ? duskKey : dawnKey];
    if (!isNaN(at.getTime())) return { at, state: 'normal' };
    // null with 'normal' only for an invalid date (no peak either).
    return { at: null, state: isNaN(peak) ? 'normal' : peak < line ? 'stays-dark' : 'no-true-night' };
}

/** First light (civil dawn by default) on the location's day. */
export function getFirstLight(date: Date, lat: number, lon: number, tz?: string, kind?: TwilightKind): LightTime {
    return lightTime(false, date, lat, lon, tz, kind);
}

/** Last light (civil dusk by default) on the location's day. */
export function getLastLight(date: Date, lat: number, lon: number, tz?: string, kind?: TwilightKind): LightTime {
    return lightTime(true, date, lat, lon, tz, kind);
}

/** The sun's altitude in degrees at an instant (no refraction). */
export function sunAltitudeDeg(at: Date, lat: number, lon: number): number {
    return SunCalc.getPosition(at, lat, lon).altitude / RAD;
}

// ── Moon position (Astronomical Almanac low-precision series) ────
//
// SunCalc's moon drops the evection, variation and annual terms and treats
// the geocentric altitude as topocentric (no parallax): its rise/set ran
// 8 min late at Marseille and 29 min at Tromsø against USNO. The Almanac's
// low-precision formulae (±0.3° in longitude, parallax to 0.003°) land
// within 2 min of USNO on every test fixture.

function moonSky(ms: number, lat: number, lon: number) {
    const d = (ms - Date.UTC(2000, 0, 1, 12)) / 86_400_000;
    const T = d / 36525;
    const s = (a: number, b: number) => Math.sin((a + b * T) * RAD);
    const c = (a: number, b: number) => Math.cos((a + b * T) * RAD);
    const L =
        (218.32 +
            481267.881 * T +
            6.29 * s(135, 477198.87) -
            1.27 * s(259.3, -413335.36) +
            0.66 * s(235.7, 890534.22) +
            0.21 * s(269.9, 954397.74) -
            0.19 * s(357.5, 35999.05) -
            0.11 * s(186.5, 966404.03)) *
        RAD;
    const B =
        (5.13 * s(93.3, 483202.02) +
            0.28 * s(228.2, 960400.89) -
            0.28 * s(318.3, 6003.15) -
            0.17 * s(217.6, -407332.21)) *
        RAD;
    const parallax =
        (0.9508 +
            0.0518 * c(135, 477198.87) +
            0.0095 * c(259.3, -413335.36) +
            0.0078 * c(235.7, 890534.22) +
            0.0028 * c(269.9, 954397.74)) *
        RAD;
    const e = (23.4393 - 3.563e-7 * d) * RAD;
    const ra = Math.atan2(Math.sin(L) * Math.cos(e) - Math.tan(B) * Math.sin(e), Math.cos(L));
    const dec = Math.asin(Math.sin(B) * Math.cos(e) + Math.cos(B) * Math.sin(e) * Math.sin(L));
    const H = (280.46061837 + 360.98564736629 * d + lon) * RAD - ra;
    const phi = lat * RAD;
    const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
    // Azimuth from south, west positive — SunCalc's convention.
    const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
    return { alt, az, parallax };
}

/** Geocentric altitude above the rise/set line: the upper limb on the
 *  refracted horizon is 0.7275 × parallax − 0.5667° (Meeus, ch. 15). */
function moonAboveHorizon(ms: number, lat: number, lon: number): number {
    const m = moonSky(ms, lat, lon);
    return m.alt - (0.7275 * m.parallax - 0.5667 * RAD);
}

export type MoonState = 'normal' | 'always-up' | 'always-down';

export interface MoonTimes {
    rise?: Date;
    set?: Date;
    state: MoonState;
}

/**
 * Moonrise and moonset on the location's calendar day (the phone's day when
 * `tz` is absent). Quadratic search in 2-hour steps — SunCalc's method —
 * but from the location's midnight, over the day's real length (23–25 h on
 * a daylight-saving day).
 */
export function getMoonTimes(date: Date, lat: number, lon: number, tz?: string): MoonTimes {
    const start = startOfLocalDay(date, tz).getTime();
    const span = (startOfLocalDay(new Date(start + 26 * HOUR_MS), tz).getTime() - start) / HOUR_MS;
    const f = (h: number) => moonAboveHorizon(start + h * HOUR_MS, lat, lon);
    let h0 = f(0);
    let rise: number | undefined;
    let set: number | undefined;
    for (let i = 1; i <= span && (rise === undefined || set === undefined); i += 2) {
        const h1 = f(i);
        const h2 = f(i + 1);
        const a = (h0 + h2) / 2 - h1;
        const b = (h2 - h0) / 2;
        const xe = -b / (2 * a);
        const ye = (a * xe + b) * xe + h1;
        const disc = b * b - 4 * a * h1;
        const roots: number[] = [];
        if (disc >= 0) {
            const dx = Math.sqrt(disc) / (Math.abs(a) * 2);
            for (const x of [xe - dx, xe + dx]) if (Math.abs(x) <= 1) roots.push(i + x);
        }
        if (roots.length === 1) {
            if (h0 < 0) rise ??= roots[0];
            else set ??= roots[0];
        } else if (roots.length === 2) {
            rise ??= ye < 0 ? roots[1] : roots[0];
            set ??= ye < 0 ? roots[0] : roots[1];
        }
        h0 = h2;
    }
    // An event past the day's end belongs to tomorrow.
    if (rise !== undefined && rise >= span) rise = undefined;
    if (set !== undefined && set >= span) set = undefined;
    const out: MoonTimes = { state: 'normal' };
    if (rise !== undefined) out.rise = new Date(start + rise * HOUR_MS);
    if (set !== undefined) out.set = new Date(start + set * HOUR_MS);
    if (rise === undefined && set === undefined && Math.sign(f(0)) === Math.sign(f(span))) {
        out.state = f(0) > 0 ? 'always-up' : 'always-down';
    }
    return out;
}

/** Is the moon's upper limb above the horizon at this instant? */
export function isMoonUp(at: Date, lat: number, lon: number): boolean {
    return moonAboveHorizon(at.getTime(), lat, lon) > 0;
}

// ── Moon Data ────────────────────────────────────────────────────

export interface MoonData {
    phaseName: string;
    phaseRatio: number; // 0–1 cycle (0 = new, 0.5 = full)
    illumination: number; // 0–1 fraction illuminated
    moonrise?: string; // HH:MM; MOON_STAYS_UP / MOON_STAYS_DOWN; undefined if no rise that day
    moonset?: string; // HH:MM; MOON_STAYS_UP / MOON_STAYS_DOWN; undefined if no set that day
    moonriseAt?: Date;
    moonsetAt?: Date;
    moonState: MoonState;
    altitude: number; // radians above horizon (apparent: parallax and refraction applied)
    azimuth: number; // radians from south (west positive)
}

/**
 * Get moon phase data only (no location needed — phase is global).
 * Backward-compatible drop-in for the old synodic-month calculation.
 */
export function getMoonPhase(date: Date): { phaseName: string; phaseRatio: number; illumination: number } {
    const illum = SunCalc.getMoonIllumination(date);
    return {
        phaseName: phaseNameFromValue(illum.phase),
        phaseRatio: illum.phase,
        illumination: illum.fraction,
    };
}

/**
 * Compute full moon data: phase, illumination, rise/set, sky position.
 * @param date  Date (current time for accurate position)
 * @param lat   Latitude
 * @param lon   Longitude
 * @param tz    Optional IANA timezone: rise/set are for the location's day, on its clock
 */
export function getMoonData(date: Date, lat: number, lon: number, tz?: string): MoonData {
    const illum = SunCalc.getMoonIllumination(date);
    const times = getMoonTimes(date, lat, lon, tz);
    const sky = moonSky(date.getTime(), lat, lon);
    const topo = sky.alt - sky.parallax * Math.cos(sky.alt);
    const h = Math.max(topo, 0);
    // Refraction as SunCalc applies it (Sæmundsson), floored at the horizon.
    const altitude = topo + 0.0002967 / Math.tan(h + 0.00312536 / (h + 0.08901179));
    const word =
        times.state === 'always-up' ? MOON_STAYS_UP : times.state === 'always-down' ? MOON_STAYS_DOWN : undefined;

    return {
        phaseName: phaseNameFromValue(illum.phase),
        phaseRatio: illum.phase,
        illumination: illum.fraction,
        moonrise: times.rise ? toHHMM(times.rise, tz) : word,
        moonset: times.set ? toHHMM(times.set, tz) : word,
        moonriseAt: times.rise,
        moonsetAt: times.set,
        moonState: times.state,
        altitude,
        azimuth: sky.az,
    };
}

// ── Moonlight by night ───────────────────────────────────────────

export interface NightMoonlight {
    startMs: number;
    endMs: number;
    /** Hours with the sun more than 6° down (civil dark) inside the window. */
    darkHours: number;
    /** Of those, hours with the moon above the horizon. */
    moonUpHours: number;
    /** Mean lit fraction while the moon is up in the dark (at mid-night when it never rises). */
    illumination: number;
    /** Lit fraction × moon-up dark hours: hours of full-moon-equivalent light. */
    moonlightHours: number;
}

/**
 * Darkness and moonlight per night between two instants, at a position that
 * may move (`positionAt` — a vessel on a planned route). Sampled every
 * `stepMinutes`; each run of civil dark is one night, cut at local noon (mean
 * solar time at the position) so the polar night's unbroken dark still gives
 * one night per day instead of one for the whole run.
 */
export function moonlightByNight(
    startMs: number,
    endMs: number,
    positionAt: (ms: number) => { lat: number; lon: number },
    stepMinutes = 10,
): NightMoonlight[] {
    const step = stepMinutes * 60_000;
    const nights: NightMoonlight[] = [];
    let night: NightMoonlight | null = null;
    // Local mean solar hour, 0–24. Continuous across the date line (only the
    // civil date jumps there), so a crossing never reads as a noon.
    const solarHour = (ms: number, lon: number) => (((ms / HOUR_MS + lon / 15) % 24) + 24) % 24;
    let lastHour = NaN;
    for (let t = startMs; t < endMs; t += step) {
        const dt = Math.min(step, endMs - t);
        const mid = t + dt / 2;
        const p = positionAt(mid);
        const hour = solarHour(mid, p.lon);
        const ahead = (((hour - lastHour) % 24) + 24) % 24;
        const pastNoon = lastHour < 12 && ahead < 12 && lastHour + ahead >= 12;
        lastHour = hour;
        if (sunAltitudeDeg(new Date(mid), p.lat, p.lon) >= -6) {
            night = null;
            continue;
        }
        if (pastNoon) night = null;
        if (!night) {
            night = { startMs: t, endMs: t, darkHours: 0, moonUpHours: 0, illumination: 0, moonlightHours: 0 };
            nights.push(night);
        }
        const h = dt / HOUR_MS;
        night.endMs = t + dt;
        night.darkHours += h;
        if (moonAboveHorizon(mid, p.lat, p.lon) > 0) {
            night.moonUpHours += h;
            night.moonlightHours += SunCalc.getMoonIllumination(new Date(mid)).fraction * h;
        }
    }
    for (const n of nights) {
        n.illumination =
            n.moonUpHours > 0
                ? n.moonlightHours / n.moonUpHours
                : SunCalc.getMoonIllumination(new Date((n.startMs + n.endMs) / 2)).fraction;
    }
    return nights;
}

// ── Golden Hour (SunCalc-accurate) ──────────────────────────────

export interface GoldenHourWindows {
    morning: { start: string; end: string };
    evening: { start: string; end: string };
}

/**
 * Return accurate golden-hour windows using SunCalc's solar model.
 *   Morning: sunrise → goldenHourEnd
 *   Evening: goldenHour → sunset
 *
 * Far more accurate than the old ±30min approximation — actual solar
 * altitude angle varies with latitude and season.
 */
export function getGoldenHourFromCoords(date: Date, lat: number, lon: number, tz?: string): GoldenHourWindows {
    const { times } = sunTimes(date, lat, lon, tz);
    return {
        morning: {
            start: toHHMM(times.sunrise, tz),
            end: toHHMM(times.goldenHourEnd, tz),
        },
        evening: {
            start: toHHMM(times.goldenHour, tz),
            end: toHHMM(times.sunset, tz),
        },
    };
}

/**
 * Is the current moment inside a golden-hour window?
 * Uses SunCalc's solar altitude model for precise boundaries.
 */
export function isGoldenHourFromCoords(date: Date, lat: number, lon: number): boolean {
    const times = SunCalc.getTimes(date, lat, lon);
    const now = date.getTime();
    const inMorning = now >= times.sunrise.getTime() && now <= times.goldenHourEnd.getTime();
    const inEvening = now >= times.goldenHour.getTime() && now <= times.sunset.getTime();
    return inMorning || inEvening;
}

// ── Convenience: Full Celestial Snapshot ─────────────────────────

export interface CelestialSnapshot {
    solar: SolarTimes;
    moon: MoonData;
    goldenHour: GoldenHourWindows;
}

/**
 * One-call convenience returning all celestial data for a date + location.
 * Ideal for dashboard widgets that need everything at once.
 */
export function getCelestialSnapshot(date: Date, lat: number, lon: number, tz?: string): CelestialSnapshot {
    return {
        solar: getSolarTimes(date, lat, lon, tz),
        moon: getMoonData(date, lat, lon, tz),
        goldenHour: getGoldenHourFromCoords(date, lat, lon, tz),
    };
}
