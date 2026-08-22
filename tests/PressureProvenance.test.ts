/**
 * "Is it credible data?" (Shane 2026-08-22). It is — NOAA GFS PRMSL from the
 * authoritative GRIB2 — but the label said only "GFS", or "Fallback" once it
 * had quietly changed provider. Both fail the question in different ways:
 * GFS runs 6-hourly so the model alone cannot say WHICH forecast this is, and
 * "Fallback" does not name Open-Meteo, whose CC-BY terms require crediting.
 */
import { describe, expect, it } from 'vitest';
import {
    PRESSURE_RUN_STALE_HOURS,
    pressureProvenance,
    pressureSourceText,
} from '../services/weather/pressureProvenance';

const RUN = '2026-08-22T18:00:00Z';
const at = (hoursAfterRun: number) => Date.parse(RUN) + hoursAfterRun * 3_600_000;

describe('pressure provenance', () => {
    it('names the GFS cycle, not just the model', () => {
        const p = pressureProvenance('gfs', RUN, at(2));
        expect(p.label).toBe('GFS 18Z');
        expect(p.runAgeHours).toBe(2);
        expect(p.stale).toBe(false);
        expect(pressureSourceText(p)).toBe('GFS 18Z');
    });

    it('pads a single-digit cycle so 06Z never reads as 6Z', () => {
        expect(pressureProvenance('gfs', '2026-08-22T06:00:00Z', at(0)).label).toBe('GFS 06Z');
        expect(pressureProvenance('gfs', '2026-08-22T00:00:00Z', at(0)).label).toBe('GFS 00Z');
    });

    it('says how old a stale run is, so the skipper is not left assuming', () => {
        const fresh = pressureProvenance('gfs', RUN, at(PRESSURE_RUN_STALE_HOURS - 1));
        expect(fresh.stale).toBe(false);
        expect(pressureSourceText(fresh)).toBe('GFS 18Z');

        const old = pressureProvenance('gfs', RUN, at(9));
        expect(old.stale).toBe(true);
        expect(pressureSourceText(old)).toBe('GFS 18Z · 9h old');
    });

    it('tolerates a still-publishing cycle rather than crying stale', () => {
        // NOMADS publishes a cycle over roughly four hours. A threshold tight
        // enough to catch a missed cycle must not flag a fresh one mid-upload.
        expect(PRESSURE_RUN_STALE_HOURS).toBeGreaterThan(6);
        expect(pressureProvenance('gfs', RUN, at(6)).stale).toBe(false);
    });

    it('NAMES Open-Meteo on fallback — that is a licence condition', () => {
        // CC-BY. "Fallback" credited nobody, on the one screen where the
        // substitution actually happened.
        const p = pressureProvenance('open-meteo', null, at(1));
        expect(p.label).toBe('Open-Meteo');
        expect(pressureSourceText(p)).toBe('Open-Meteo');
    });

    it('admits an unknown run instead of inventing a cycle', () => {
        expect(pressureProvenance('gfs', null, at(1)).label).toBe('GFS');
        expect(pressureProvenance('gfs', 'not-a-date', at(1)).label).toBe('GFS');
        expect(pressureProvenance('gfs', null, at(1)).runAgeHours).toBeNull();
    });

    it('treats a run timestamped in the future as a clock fault, not freshness', () => {
        const p = pressureProvenance('gfs', RUN, at(-3));
        expect(p.runAgeHours).toBe(0);
        expect(p.stale).toBe(false);
    });

    it('shows an em dash when there is no source at all', () => {
        expect(pressureProvenance(null, null, at(0)).label).toBe('—');
    });
});
