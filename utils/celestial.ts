/**
 * celestial.ts — Offline astronomical calculations via SunCalc.
 *
 * Provides sunrise/sunset, dawn/dusk, golden hour, moon phase, moonrise/moonset,
 * and moon position — all computed mathematically from date + GPS coordinates.
 *
 * Zero API calls. Works 500 miles offshore with no cell reception.
 */
import SunCalc from 'suncalc';

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

// ── Solar Times ──────────────────────────────────────────────────

export interface SolarTimes {
    sunrise: string; // HH:MM
    sunset: string; // HH:MM
    dawn: string; // HH:MM — civil twilight start
    dusk: string; // HH:MM — civil twilight end
    nauticalDawn: string; // HH:MM
    nauticalDusk: string; // HH:MM
    goldenHourStart: string; // HH:MM — evening golden hour starts
    goldenHourEnd: string; // HH:MM — morning golden hour ends
    solarNoon: string; // HH:MM
}

/**
 * Compute all solar event times for a given date and location.
 * @param date  Date (noon of the target day is ideal)
 * @param lat   Latitude
 * @param lon   Longitude
 * @param tz    Optional IANA timezone (e.g. "Australia/Brisbane")
 */
export function getSolarTimes(date: Date, lat: number, lon: number, tz?: string): SolarTimes {
    const times = SunCalc.getTimes(date, lat, lon);
    return {
        sunrise: toHHMM(times.sunrise, tz),
        sunset: toHHMM(times.sunset, tz),
        dawn: toHHMM(times.dawn, tz),
        dusk: toHHMM(times.dusk, tz),
        nauticalDawn: toHHMM(times.nauticalDawn, tz),
        nauticalDusk: toHHMM(times.nauticalDusk, tz),
        goldenHourStart: toHHMM(times.goldenHour, tz), // evening golden hour start
        goldenHourEnd: toHHMM(times.goldenHourEnd, tz), // morning golden hour end
        solarNoon: toHHMM(times.solarNoon, tz),
    };
}

// ── Moon Data ────────────────────────────────────────────────────

export interface MoonData {
    phaseName: string;
    phaseRatio: number; // 0–1 cycle (0 = new, 0.5 = full)
    illumination: number; // 0–1 fraction illuminated
    moonrise?: string; // HH:MM (undefined if no rise on this date)
    moonset?: string; // HH:MM (undefined if no set on this date)
    altitude: number; // radians above horizon
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
 * @param tz    Optional IANA timezone for formatting moonrise/moonset
 */
export function getMoonData(date: Date, lat: number, lon: number, tz?: string): MoonData {
    const illum = SunCalc.getMoonIllumination(date);
    const times = SunCalc.getMoonTimes(date, lat, lon);
    const pos = SunCalc.getMoonPosition(date, lat, lon);

    return {
        phaseName: phaseNameFromValue(illum.phase),
        phaseRatio: illum.phase,
        illumination: illum.fraction,
        moonrise: times.rise ? toHHMM(times.rise, tz) : undefined,
        moonset: times.set ? toHHMM(times.set, tz) : undefined,
        altitude: pos.altitude,
        azimuth: pos.azimuth,
    };
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
    const times = SunCalc.getTimes(date, lat, lon);
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
