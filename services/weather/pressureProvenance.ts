/**
 * What the pressure pill should say about where its numbers came from.
 *
 * Shane 2026-08-22 asked that the pressure layer be "credible data". It IS
 * credible — NOAA GFS PRMSL, decoded from the authoritative GRIB2 — but the
 * label said only "GFS", or "Fallback" when it had quietly switched provider.
 * Two problems with that:
 *
 *  1. GFS runs on a 6-hourly cycle, so "GFS" alone cannot answer the question
 *     a skipper actually has, which is WHICH RUN am I looking at and how old
 *     is it. A 00Z run at 1000 local is a very different thing from a 06Z one.
 *  2. "Fallback" does not name Open-Meteo. Their data is CC-BY: naming the
 *     source is a LICENCE CONDITION, not presentation. Calling it "Fallback"
 *     failed that quietly, on the one screen where the substitution happened.
 *
 * Pure so the wording is testable without a map.
 */

/** A GFS cycle is 6-hourly. Past this a cycle is late or we are holding an
 *  old one — either way the skipper should be told rather than left to assume
 *  the isobars are current. Deliberately generous: NOMADS publishes a cycle
 *  over ~4 h, so a fresh-but-still-uploading run must not read as stale. */
export const PRESSURE_RUN_STALE_HOURS = 8;
export const PRESSURE_REFRESH_MS = 30 * 60_000;

export interface PressureTimeGrid {
    refTime: string | null;
    subFrameStepHours: number;
    totalHours: number;
    keyframeFhrs?: readonly number[];
    source?: 'gfs' | 'open-meteo';
}

/** Frame zero may be a non-zero lead time; include it in every UTC conversion. */
export function pressureFrameValidAt(grid: PressureTimeGrid | null, frameIndex: number): number | null {
    if (
        !grid ||
        !Number.isFinite(frameIndex) ||
        frameIndex < 0 ||
        !Number.isInteger(grid.totalHours) ||
        grid.totalHours < 1 ||
        frameIndex > grid.totalHours - 1
    )
        return null;
    const base = Date.parse(grid.refTime ?? '');
    const first = grid.keyframeFhrs?.[0] ?? 0;
    if (
        !Number.isFinite(base) ||
        !Number.isFinite(first) ||
        !Number.isFinite(grid.subFrameStepHours) ||
        grid.subFrameStepHours <= 0
    )
        return null;
    return base + (first + Math.max(0, Math.round(frameIndex)) * grid.subFrameStepHours) * 3_600_000;
}

export function pressureCoverage(grid: PressureTimeGrid | null): { startMs: number; endMs: number } | null {
    const startMs = pressureFrameValidAt(grid, 0);
    const endMs = grid ? pressureFrameValidAt(grid, grid.totalHours - 1) : null;
    return startMs === null || endMs === null ? null : { startMs, endMs };
}

/** Never substitute an endpoint for an instant outside the forecast window. */
export function pressureCoversTime(grid: PressureTimeGrid | null, validAt: number): boolean {
    const coverage = pressureCoverage(grid);
    return !!coverage && Number.isFinite(validAt) && validAt >= coverage.startMs && validAt <= coverage.endMs;
}

export function pressureFrameWithinCoverage(grid: PressureTimeGrid | null, validAt: number | null): number | null {
    return validAt !== null && pressureCoversTime(grid, validAt) ? pressureFrameForValidAt(grid, validAt) : null;
}

/** Fetch age is NOT model age. Even a just-downloaded response can be expired. */
export function pressureCacheIsFresh(grid: PressureTimeGrid | null, fetchedAt: number, now = Date.now()): boolean {
    const age = now - fetchedAt;
    return fetchedAt > 0 && age >= 0 && age < PRESSURE_REFRESH_MS && pressureCoversTime(grid, now);
}

/** Keep the last usable field if an upstream cache goes backwards. Open-Meteo
 * exposes a valid-time origin, not a run, so compare clocks only within a source. */
export function pressureReplacementError(
    candidate: PressureTimeGrid,
    previous: PressureTimeGrid | null = null,
    now = Date.now(),
): string | null {
    if (!pressureCoversTime(candidate, now)) return 'Pressure forecast does not cover the current time';
    const run = Date.parse(candidate.refTime ?? '');
    if (candidate.source === 'gfs' && run > now) return 'Pressure model run is in the future';
    if (previous && previous.source === candidate.source && run < Date.parse(previous.refTime ?? '')) {
        return 'Pressure refresh returned an older forecast';
    }
    return null;
}

/** Wind playback can be fractional; follow its UTC instant, never a guessed
 * offset between two independently rounded "Now" indices. */
export function pressureWindValidAt(
    refTime: string | null | undefined,
    hours: readonly number[],
    index: number,
): number | null {
    const reference = Date.parse(refTime ?? '');
    if (!Number.isFinite(reference) || !Number.isFinite(index) || index < 0 || index > hours.length - 1) return null;
    const i0 = Math.floor(index);
    const i1 = Math.min(i0 + 1, hours.length - 1);
    if (!Number.isFinite(hours[i0]) || !Number.isFinite(hours[i1])) return null;
    return reference + (hours[i0] + (hours[i1] - hours[i0]) * (index - i0)) * 3_600_000;
}

export function pressureFrameForValidAt(grid: PressureTimeGrid | null, validAt: number | null): number | null {
    const first = pressureFrameValidAt(grid, 0);
    if (
        !grid ||
        first === null ||
        validAt === null ||
        !Number.isFinite(validAt) ||
        !Number.isFinite(grid.totalHours) ||
        grid.totalHours < 1
    )
        return null;
    return Math.max(
        0,
        Math.min(Math.round((validAt - first) / (grid.subFrameStepHours * 3_600_000)), grid.totalHours - 1),
    );
}

export function pressureValidTimeText(validAt: number | null | undefined): string {
    if (validAt == null || !Number.isFinite(validAt)) return 'Valid time unknown';
    const date = new Date(validAt);
    return `Valid ${date.toISOString().slice(5, 10)} ${date.toISOString().slice(11, 16)} UTC`;
}

export interface PressureProvenance {
    /** Source + model run, e.g. "GFS 18Z" or "Open-Meteo". */
    label: string;
    /** Whole hours since the model run, or null when unknown. */
    runAgeHours: number | null;
    /** True when the run is old enough that the skipper should know. */
    stale: boolean;
}

export function pressureProvenance(
    source: 'gfs' | 'open-meteo' | null,
    refTime: string | null | undefined,
    now: number = Date.now(),
): PressureProvenance {
    // Open-Meteo is named, always. It is the licence condition, and it is also
    // the honest answer: a different provider is a different forecast, not a
    // degraded version of the same one.
    if (source === 'open-meteo') {
        return { label: 'GFS · Open-Meteo coarse fallback', runAgeHours: null, stale: false };
    }
    if (source !== 'gfs') return { label: '—', runAgeHours: null, stale: false };

    const parsed = refTime ? Date.parse(refTime) : NaN;
    if (!Number.isFinite(parsed)) {
        // Source known, run not. Say GFS and stop — inventing a cycle would be
        // worse than admitting we do not know which one.
        return { label: 'GFS', runAgeHours: null, stale: false };
    }

    const cycle = new Date(parsed).getUTCHours();
    const ageHours = Math.floor((now - parsed) / 3_600_000);
    return {
        label: `GFS ${String(cycle).padStart(2, '0')}Z`,
        runAgeHours: Math.max(0, ageHours),
        // A run in the FUTURE is a clock problem, not a stale one; clamping
        // the age above keeps that from reading as fresh-and-fine either way.
        stale: ageHours >= PRESSURE_RUN_STALE_HOURS,
    };
}

/** The pill's source segment: "GFS 18Z" normally, "GFS 18Z · 9h old" when the
 *  cycle has gone stale enough to matter. */
export function pressureSourceText(p: PressureProvenance): string {
    if (p.stale && p.runAgeHours !== null) return `${p.label} · ${p.runAgeHours}h old`;
    return p.label;
}
