/**
 * The top and the span of a loaded tide curve — the highest tide the app
 * knows at a place (owner decision 10, 2026-09-30), and over how many days it
 * was read. Pure. Carved out of components/map/tideWindowChips.ts (owner
 * decision 11, 2026-10-01): the router reads the same top BEFORE routing, per
 * place (services/routing/tideCeilings), so it must not live in a map module.
 *
 * FROM WHEN (fix-up, 2026-10-01): every curve starts at yesterday 00:00 (the
 * tide proxy's anchor), so a top over the whole span could be a spring high
 * that has already happened — a 0–0.35 m band read clearable on yesterday's
 * 2.6 m when no tide to come cleared it, and the refusal named that past tide
 * as "the highest in the next 14 days". Both readers pass `fromMs` — the
 * later of now and the departure — and the top and the days are read from
 * there on, so the line's colour (decision 10) and the router (decision 11)
 * agree.
 */
import type { TideCurve } from '../TideHeightService';

const DAY_MS = 24 * 3600_000;

/** Sweep step for a curve's top when it carries no maxHeightM. */
const HIGHEST_SWEEP_MS = 5 * 60_000;

/** The window the route's tide chips search for a clearing window, from the
 *  departure (tideWindowChips) — and the window the router's tide ceilings
 *  are fetched for (services/routing/tideCeilings), so both read the same
 *  curves. One constant for both (fix-up, 2026-10-01: two copies could
 *  drift apart and fetch twice, silently). */
export const TIDE_WINDOW_HORIZON_MS = 24 * 3600_000;

/** The most tide curves one route loads (one per 0.25° bucket): the router's
 *  ceilings before it routes, and the chips after (fix-up, 2026-10-01: the
 *  router asked for 9 of its own; the public tide proxy allows 12 an hour
 *  per address, and a boat's Pi and phone share one). */
export const ROUTE_TIDE_CURVES_MAX = 4;

/**
 * The highest tide the app knows at the curve's station, m above LAT (owner
 * decision 10, 2026-09-30): the top of the loaded curve over its span from
 * `fromMs` on (the whole span when omitted) — days of it, not only the 24 h
 * window — since WorldTides sends no highest astronomical tide. The curve's
 * own maxHeightM when it agrees with what the curve actually yields (heightAt
 * refuses a mismatched HW/LW pair, and so must this), else a 5-minute sweep.
 * Null when the curve yields nothing from then on.
 */
export function curveHighestM(curve: TideCurve, fromMs?: number): number | null {
    const [rangeA, b] = curve.rangeMs;
    const a = typeof fromMs === 'number' && Number.isFinite(fromMs) ? Math.max(rangeA, fromMs) : rangeA;
    let swept = -Infinity;
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a) {
        for (let t = a; t <= b; t += HIGHEST_SWEEP_MS) {
            const h = curve.heightAt(t);
            if (h !== null && h > swept) swept = h;
        }
        const end = curve.heightAt(b);
        if (end !== null && end > swept) swept = end;
    }
    if (!Number.isFinite(swept)) return null;
    // maxHeightM is the whole curve's: no use once the start is cut.
    if (a > rangeA) return swept;
    const top = curve.maxHeightM;
    return typeof top === 'number' && Number.isFinite(top) && top >= swept && top <= swept + 0.05 ? top : swept;
}

/** Whole days a curve spans from `fromMs` on (the whole span when omitted;
 *  at least 1) — what its top was read over. */
export function curveSpanDays(curve: TideCurve, fromMs?: number): number {
    const [rangeA, b] = curve.rangeMs;
    const a = typeof fromMs === 'number' && Number.isFinite(fromMs) ? Math.max(rangeA, fromMs) : rangeA;
    return Math.max(1, Math.round((b - a) / DAY_MS));
}
