/**
 * The words for a route's DRY stretches (package 125-05; RouteResult.dryRuns,
 * services/engine/types DryRun).
 *
 * Shane, 2026-10-08: "better we just have red at the "dry" zones, rather than
 * just shit caning the whole route". Where no tide clears part of a route the
 * router routes it anyway, red there, and the route says which stretches,
 * each with its charted depth against what the boat needs (draft + UKC) and
 * the highest tide known there — or that there is no tide data. One line,
 * shared by the passage planner, the voyage form, Auto and the tracer's ⚡
 * route (components/map/inshoreRouteNotice inshoreRouteCaveats), kept with a
 * saved plan, and read back by the follow gate (services/traceDirectUseGate):
 * a planned route carrying it is a red finding — two taps to follow.
 *
 * Pure, and small: it rides the main bundle.
 */
import type { DryRun } from '../engine/types';
import type { TraceFollowStatus } from '../traceVerification';

/** Every dry-stretch line starts with this — the follow gate's marker. */
export const DRY_RUN_CAVEAT_PREFIX = 'Red on this route';

/** Stretches named one by one; the rest are counted. */
const NAMED_MAX = 3;

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const m1 = (m: number): string => `${m.toFixed(1)} m`;
/** A band's own figure: "0", "0.3", "2". */
const fig = (m: number): string => (Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1));

/** "dries 2.2 m" / "is charted 0–0.3 m" / "is charted no deeper than 0.3 m". */
function depthWords(run: DryRun): string {
    const s = run.shallowestM;
    if (s !== null && s < 0) return `dries ${m1(-s)}`;
    return s === null ? `is charted no deeper than ${m1(run.deepestM)}` : `is charted ${fig(s)}–${fig(run.deepestM)} m`;
}

/** "(2.4 m draft + 0.5 m under the keel)" */
const needParts = (run: DryRun): string => `${m1(run.draftM)} draft + ${m1(run.needM - run.draftM)} under the keel`;

const usable = (run: DryRun | null | undefined): run is DryRun =>
    !!run &&
    typeof run.place === 'string' &&
    run.place.trim() !== '' &&
    finite(run.needM) &&
    finite(run.draftM) &&
    finite(run.deepestM) &&
    (run.shallowestM === null || finite(run.shallowestM)) &&
    (run.tide === null || (finite(run.tide.topM) && finite(run.tide.days)));

/**
 * The route note for its dry stretches, or null when it has none:
 *   "Red on this route: the Boat Passage dries 2.2 m and you need 2.9 m (2.4 m
 *   draft + 0.5 m under the keel); the highest tide in the next 14 days is
 *   2.5 m, so no tide clears it. Check it on the chart before you go."
 */
export function dryRunCaveat(runs: readonly DryRun[] | null | undefined): string | null {
    const ok = (Array.isArray(runs) ? runs : []).filter(usable);
    if (ok.length === 0) return null;
    if (ok.length === 1) {
        const r = ok[0];
        const tide = r.tide
            ? `the highest tide in the next ${r.tide.days} day${r.tide.days === 1 ? '' : 's'} is ${m1(r.tide.topM)}, so no tide clears it`
            : 'there is no tide data for it, so no tide can be shown to clear it';
        return `${DRY_RUN_CAVEAT_PREFIX}: ${r.place} ${depthWords(r)} and you need ${m1(r.needM)} (${needParts(r)}); ${tide}. Check it on the chart before you go.`;
    }
    const named = ok.slice(0, NAMED_MAX).map((r) => {
        const tide = r.tide ? `highest tide ${m1(r.tide.topM)} in the next ${r.tide.days} days` : 'no tide data';
        return `${r.place} ${depthWords(r)} (${tide})`;
    });
    const more = ok.length > NAMED_MAX ? `; and ${ok.length - NAMED_MAX} more` : '';
    const first = ok[0];
    // "No tide clears" only where every stretch's tide is known: with no tide
    // data nothing proves it (review fix-up, 2026-10-09) — they are dry
    // stretches, and how many have no tide data is said.
    const noData = ok.filter((r) => r.tide === null).length;
    const what =
        noData === 0
            ? `${ok.length} stretches no tide clears`
            : `${ok.length} dry stretches, ${noData === ok.length ? 'no' : `${noData} with no`} tide data`;
    return `${DRY_RUN_CAVEAT_PREFIX} — ${what} (you need ${m1(first.needM)}: ${needParts(first)}): ${named.join('; ')}${more}. Check them on the chart before you go.`;
}

/**
 * The route notice's title for its dry stretches, or null when it has none:
 * "No tide clears part of this route" only where every stretch's tide is
 * known; "No tide data for part of this route" where none is; else "Red on
 * part of this route" (review fix-up, 2026-10-09: the title stated as proven
 * what the note said was unknown).
 */
export function dryRunNoticeTitle(runs: readonly DryRun[] | null | undefined): string | null {
    const ok = (Array.isArray(runs) ? runs : []).filter(usable);
    if (ok.length === 0) return null;
    const noData = ok.filter((r) => r.tide === null).length;
    return noData === 0
        ? 'No tide clears part of this route'
        : noData === ok.length
          ? 'No tide data for part of this route'
          : 'Red on part of this route';
}

/** Is this a route note for dry stretches (dryRunCaveat)? */
export function isDryRunCaveat(line: unknown): line is string {
    return typeof line === 'string' && line.startsWith(DRY_RUN_CAVEAT_PREFIX);
}

/** The follow row's short reason for such a note: up to its first bracket. */
export function dryRunFollowReason(line: string): string {
    const cut = line.indexOf(' (');
    return (cut > 0 ? line.slice(0, cut) : line).trim();
}

/**
 * A planned route's own finding when it has no trace to check: the router
 * drew it red where no tide clears it, and its notes say so — the route's
 * caveats (RouteOrTrack.caveats), or a log entry's notes, where PassagePlanSave
 * keeps each caveat on a line of its own after a '⚠ '. The follow row's red —
 * "Tap again to follow anyway" — is the routecheck's own (services/
 * traceVerification), not a second gate. Null when they carry no dry stretch.
 */
export function plannedRouteDryFinding(
    notes: readonly unknown[] | string | null | undefined,
): (TraceFollowStatus & { reason: string }) | null {
    const lines = typeof notes === 'string' ? notes.split('\n') : Array.isArray(notes) ? notes : [];
    for (const raw of lines) {
        if (typeof raw !== 'string') continue;
        const at = raw.indexOf(DRY_RUN_CAVEAT_PREFIX);
        // At the line's start, or after its '⚠ ' marker.
        if (at < 0 || at > 3) continue;
        return { tone: 'finding', code: 'finding', reason: dryRunFollowReason(raw.slice(at)) };
    }
    return null;
}

/**
 * A saved route's dry stretches (inshoreRouteToGeoJSON), checked; undefined
 * when absent or malformed — no words rather than wrong ones.
 */
export function savedDryRuns(v: unknown): DryRun[] | undefined {
    if (!Array.isArray(v) || v.length === 0) return undefined;
    const out: DryRun[] = [];
    for (const x of v) {
        if (!x || typeof x !== 'object') return undefined;
        const r = x as Record<string, unknown>;
        const tide = r.tide as { topM?: unknown; days?: unknown } | null | undefined;
        const mid = r.mid;
        const run: DryRun = {
            startSeg: finite(r.startSeg) ? r.startSeg : 0,
            startT: finite(r.startT) ? r.startT : 0,
            endSeg: finite(r.endSeg) ? r.endSeg : 0,
            endT: finite(r.endT) ? r.endT : 0,
            lengthM: finite(r.lengthM) ? r.lengthM : 0,
            mid: Array.isArray(mid) && finite(mid[0]) && finite(mid[1]) ? [mid[0], mid[1]] : [0, 0],
            place: typeof r.place === 'string' ? r.place : '',
            shallowestM: r.shallowestM === null ? null : finite(r.shallowestM) ? r.shallowestM : Number.NaN,
            deepestM: finite(r.deepestM) ? r.deepestM : Number.NaN,
            draftM: finite(r.draftM) ? r.draftM : Number.NaN,
            needM: finite(r.needM) ? r.needM : Number.NaN,
            tide:
                tide === null
                    ? null
                    : tide && finite(tide.topM) && finite(tide.days)
                      ? { topM: tide.topM, days: tide.days }
                      : { topM: Number.NaN, days: Number.NaN },
        };
        if (!usable(run)) return undefined;
        out.push(run);
    }
    return out;
}
