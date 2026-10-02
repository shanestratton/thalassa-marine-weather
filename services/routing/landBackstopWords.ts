/**
 * What the satellite land check found, in a skipper's words (2026-10-02).
 *
 * Shane's phone, Coral Sea Marina → Daydream Island: Auto refused with
 * "Satellite relief shows land on this route … Check charts are installed
 * for the whole passage." — no where, and the charts WERE installed. A
 * refusal now says where the land is, and whether the charts are missing
 * there or show land too. One place for the words, so Auto, the passage
 * planner and the voyage form say the same thing. Pure: no network, no
 * engine — callers that mock the check itself still get these words. The
 * engine's own charted-land refusal (chartedLandFinding) lives here too, so
 * all three say it in Auto's words.
 */
import type { LandBackstopResult, LandRun } from './landBackstop';

/** "20.270° S, 148.724° E" — Auto's own way of saying a place. */
export function landBackstopPlace(lat: number, lon: number): string {
    return `${Math.abs(lat).toFixed(3)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(3)}° ${lon < 0 ? 'W' : 'E'}`;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** The run the words are about: one the charts show as land first, then the longest. */
export function worstLandRun(runs: readonly LandRun[]): LandRun | null {
    let worst: LandRun | null = null;
    for (const run of runs) {
        if (!worst) worst = run;
        else if ((run.charts === 'land') !== (worst.charts === 'land')) {
            if (run.charts === 'land') worst = run;
        } else if ((run.samples ?? 0) > (worst.samples ?? 0)) worst = run;
    }
    return worst;
}

/**
 * One or two sentences: where satellite relief shows land on the route, and
 * what the installed charts say there. No advice and no outcome — each caller
 * adds its own ("not shown", "falling back to offshore planning").
 */
export function landBackstopFinding(result: Pick<LandBackstopResult, 'runs'>): string {
    const runs = Array.isArray(result?.runs) ? result.runs : [];
    const run = worstLandRun(runs);
    const lat = run && finite(run.midLat) ? run.midLat : run?.lat;
    const lon = run && finite(run.midLon) ? run.midLon : run?.lon;
    const where = finite(lat) && finite(lon) ? ` near ${landBackstopPlace(lat, lon)}` : ' on this route';
    const more = runs.length > 1 ? ` (and ${runs.length - 1} other place${runs.length > 2 ? 's' : ''})` : '';
    if (run?.charts === 'land')
        return `Satellite relief shows land${where}${more}, and the installed charts show land or drying ground there too.`;
    // "Used for this route", never "installed" (review fix-up, 2026-10-02):
    // the route loads only the cells its pins' box touches, so a detailed
    // cell on this phone may simply not have been loaded — and where a
    // small-scale chart paints land too, the words must not imply water.
    if (run?.charts === 'uncharted')
        return (
            `Satellite relief shows land${where}${more}, where none of the charts used for this route is detailed enough to say whether it is water` +
            `${run.smallScaleLand ? ', and the small-scale chart there shows land too' : ''}.`
        );
    return `Satellite relief shows land${where}${more}.`;
}

/** Auto's refusal: where, what the charts say, and what to do. */
export function landBackstopRefusal(result: Pick<LandBackstopResult, 'runs'>): string {
    const run = worstLandRun(Array.isArray(result?.runs) ? result.runs : []);
    // Never "install" (review fix-up, 2026-10-02): whether a detailed chart
    // for that stretch is on this phone is not something the check knows.
    const advice =
        run?.charts === 'land'
            ? 'Plot this passage in Manual.'
            : 'Check that stretch on a detailed chart, or plot this passage in Manual.';
    return `${landBackstopFinding(result)} The route is not shown. ${advice} Nothing changed.`;
}

/**
 * The passage planner's notice title for a land refusal (review fix-up,
 * 2026-10-02): what the charts say decides it — "possible chart gap" under a
 * message saying the charts show land there too contradicted itself.
 */
export function landBackstopTitle(result: Pick<LandBackstopResult, 'runs'>): string {
    return worstLandRun(Array.isArray(result?.runs) ? result.runs : [])?.charts === 'land'
        ? 'Inshore route rejected — crosses charted land'
        : 'Inshore route rejected — possible chart gap';
}

/**
 * The engine's own charted-land audit, in Auto's words (review fix-up,
 * 2026-10-02): InshoreRouteResult.hardLand measures the route against the
 * charts every 25 m with a pin's own edge left out (decision 7). The engine
 * refuses only a run over 500 m, so Auto refuses any `awayM` above 0 — and
 * the passage planner and the voyage form now do too, before the satellite
 * check: a small charted island the ETOPO pixels miss got past both of them.
 * Null when the route crosses no charted land away from a pin (or the audit
 * did not run).
 */
export function chartedLandFinding(
    hardLand: { totalM?: unknown; awayM?: unknown; awayAt?: unknown } | null | undefined,
): string | null {
    const awayM = hardLand?.awayM;
    if (!finite(awayM) || awayM <= 0) return null;
    const at = hardLand?.awayAt;
    const near =
        Array.isArray(at) && at.length === 2 && finite(at[0]) && finite(at[1])
            ? ` near ${landBackstopPlace(at[1], at[0])}`
            : '';
    return `The only way Thalassa found crosses charted land${near}.`;
}
