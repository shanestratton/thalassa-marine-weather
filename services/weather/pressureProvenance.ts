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
        return { label: 'Open-Meteo', runAgeHours: null, stale: false };
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
