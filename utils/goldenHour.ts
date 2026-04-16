/**
 * goldenHour.ts — Golden-hour calculation utilities.
 *
 * Two modes:
 *   1. String-based (legacy): uses HH:MM sunrise/sunset with ±30min approximation.
 *   2. Coordinate-based (SunCalc): uses actual solar altitude — accurate at all latitudes.
 *
 * Prefer the coordinate-based functions when lat/lon are available.
 */
import { getGoldenHourFromCoords, isGoldenHourFromCoords } from './celestial';

export { getGoldenHourFromCoords, isGoldenHourFromCoords };

// ── Helpers ──────────────────────────────────────────────────────

/** Parse "HH:MM" → minutes-since-midnight */
function parseHHMM(t: string): number {
    if (!t || t === '--:--') return -1;
    const parts = t.replace(/[^0-9:]/g, '').split(':');
    if (parts.length < 2) return -1;
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return -1;
    return h * 60 + m;
}

/** Minutes-since-midnight → "HH:MM" */
function toHHMM(mins: number): string {
    const clamped = ((mins % 1440) + 1440) % 1440; // wrap within 0–1439
    const h = Math.floor(clamped / 60);
    const m = Math.round(clamped % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ── Public API ───────────────────────────────────────────────────

export interface GoldenHourWindow {
    start: string; // "HH:MM"
    end: string; // "HH:MM"
}

export interface GoldenHourWindows {
    morning: GoldenHourWindow;
    evening: GoldenHourWindow;
}

const GOLDEN_MINS = 30;

/**
 * Return the morning and evening golden-hour windows for a given day.
 * @param sunrise "HH:MM" (24h)
 * @param sunset  "HH:MM" (24h)
 */
export function getGoldenHourWindows(sunrise: string, sunset: string): GoldenHourWindows | null {
    const riseMins = parseHHMM(sunrise);
    const setMins = parseHHMM(sunset);
    if (riseMins < 0 || setMins < 0) return null;

    return {
        morning: {
            start: toHHMM(riseMins),
            end: toHHMM(riseMins + GOLDEN_MINS),
        },
        evening: {
            start: toHHMM(setMins - GOLDEN_MINS),
            end: toHHMM(setMins),
        },
    };
}

/**
 * Is the given time inside a golden-hour window?
 * @param sunrise "HH:MM"
 * @param sunset  "HH:MM"
 * @param now     Date (defaults to current time)
 */
export function isGoldenHour(sunrise: string, sunset: string, now?: Date): boolean {
    const windows = getGoldenHourWindows(sunrise, sunset);
    if (!windows) return false;

    const d = now || new Date();
    const nowMins = d.getHours() * 60 + d.getMinutes();

    const mStart = parseHHMM(windows.morning.start);
    const mEnd = parseHHMM(windows.morning.end);
    const eStart = parseHHMM(windows.evening.start);
    const eEnd = parseHHMM(windows.evening.end);

    return (nowMins >= mStart && nowMins < mEnd) || (nowMins >= eStart && nowMins < eEnd);
}

/**
 * Which golden-hour window (if any) is currently active?
 * @returns 'morning' | 'evening' | null
 */
export function getGoldenHourLabel(sunrise: string, sunset: string, now?: Date): 'morning' | 'evening' | null {
    const windows = getGoldenHourWindows(sunrise, sunset);
    if (!windows) return null;

    const d = now || new Date();
    const nowMins = d.getHours() * 60 + d.getMinutes();

    const mStart = parseHHMM(windows.morning.start);
    const mEnd = parseHHMM(windows.morning.end);
    if (nowMins >= mStart && nowMins < mEnd) return 'morning';

    const eStart = parseHHMM(windows.evening.start);
    const eEnd = parseHHMM(windows.evening.end);
    if (nowMins >= eStart && nowMins < eEnd) return 'evening';

    return null;
}
