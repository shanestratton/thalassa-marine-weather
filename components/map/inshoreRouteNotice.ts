/**
 * The notice band shown with a freshly drawn inshore route (PassageBanner via
 * usePassagePlanner), and the CAVEATS the route carries whatever notice is
 * showing. Pure, so the choice between them is testable.
 */
import type { PassageNotice } from './usePassagePlanner';
import type { SurveyRunInfo } from '../../services/engine/types';

export interface InshoreRouteNoticeInput {
    /** The router's per-segment safety classifications arrived intact. */
    stateMaskOk: boolean;
    destinationInlandTrimM?: number;
    structuresUnknownCells?: readonly string[];
    /** A pin on charted land or a drying bank (InshoreRouteResult.pinOffWater). */
    pinOffWater?: { origin?: 'land' | 'drying'; destination?: 'land' | 'drying' };
    /** The route's survey stretches (InshoreRouteResult.surveyRuns, owner
     *  decision 9) and the cells whose survey quality was not checked. */
    surveyRuns?: readonly SurveyRunInfo[];
    surveyUncheckedCells?: readonly string[];
    /** How much of the survey stretches THIS view draws as amber dots
     *  (inshoreRouteState surveyAmberMetres). Absent: the view draws no
     *  survey amber at all (a saved plan, the tracer), so the caveat names no
     *  colour. */
    surveyAmber?: { marginM: number; poorM: number };
    ntmLockBanner: PassageNotice | null;
}

/** Metres in a skipper's words: "1.3 km", "450 m". */
const distanceWords = (m: number): string =>
    m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`;

/**
 * What the route says about its survey quality (owner decision 9,
 * 2026-09-30: "Yes, amber on the route"): how much of it the survey may be out
 * by more than the keel margin, how much is old or ungraded, and — decision
 * 8's way — the charts whose survey quality was not checked at all.
 *
 * The colour words follow what the view actually draws (round-3 review,
 * 2026-09-30): "(amber dashes)" only when all of it is dashed, "(amber dashes
 * where the line is not already red or amber)" when some is, "(inside the red
 * or amber stretches)" when none is — and no colour at all where the view
 * draws no survey dashes (a saved plan, the tracer, the planner summary).
 * Owner decision 10 (2026-09-30) made the survey stretches DASHES — solid
 * amber is water that needs tide — and a stretch under a shallow one may be
 * amber rather than red once the tide is in; the words were "(marked amber)",
 * "(marked amber where it is not already red)" and "(under the red)". DOTS
 * since the round-4 review (2026-09-30): the dashes were the lead overlay's
 * own needs-tide pattern.
 */
const amberWords = (totalM: number, amberM: number | undefined): string => {
    if (amberM === undefined) return '';
    if (amberM <= 1) return ' (inside the red or amber stretches)';
    return amberM >= totalM - Math.max(25, totalM * 0.02)
        ? ' (amber dots)'
        : ' (amber dots where the line is not already red or amber)';
};

export function surveyCaveats(
    input: Pick<InshoreRouteNoticeInput, 'surveyRuns' | 'surveyUncheckedCells' | 'surveyAmber'>,
): string[] {
    const out: string[] = [];
    const runs = Array.isArray(input.surveyRuns) ? input.surveyRuns : [];
    let marginM = 0;
    let worstErrorM = 0;
    let poorM = 0;
    for (const r of runs) {
        if (!r || typeof r.lengthM !== 'number') continue;
        if (r.reason === 'survey-margin') {
            marginM += r.lengthM;
            if (typeof r.errorM === 'number' && r.errorM > worstErrorM) worstErrorM = r.errorM;
        } else if (r.reason === 'survey-poor' || r.reason === 'survey-ungraded') poorM += r.lengthM;
    }
    if (marginM > 0) {
        out.push(
            `Survey may be out by up to ${worstErrorM.toFixed(1)} m on ${distanceWords(marginM)} of this route — more than your keel margin there${amberWords(marginM, input.surveyAmber?.marginM)}. Tide windows there are worked from the charted depth.`,
        );
    }
    if (poorM > 0) {
        out.push(
            `Old or ungraded survey on ${distanceWords(poorM)} of this route — the charted depth there has no stated accuracy${amberWords(poorM, input.surveyAmber?.poorM)}.`,
        );
    }
    const unchecked = input.surveyUncheckedCells?.length ?? 0;
    if (unchecked > 0) {
        out.push(
            `Survey quality not checked on ${unchecked === 1 ? 'this chart' : `${unchecked} of the charts on this route`} — its accuracy is not in the chart data.`,
        );
    }
    return out;
}

/**
 * What the route itself must say, whatever notice is showing (fix-up,
 * 2026-09-30). Owner decision 8: while a chart carries no bridge / overhead
 * line layers (every installed cell is schema 1 today) the route is routed as
 * normal — only Thalassa's own bridge list (public/notices/bridges-au.json)
 * gates it — and carries a plain warning. That warning was one slot in a
 * transient band: the inland-trim notice and the NtM lock outranked it, and
 * the later "Notice to Mariners on this route" advisory overwrote it. The
 * planner now keeps these on a line of their own (usePassagePlanner
 * routeCaveats → PassageBanner) that no other notice replaces, and appends
 * them to whichever notice wins. And a pin off the water (decision 7) is said
 * here too — nothing showed it — and, since round 3 (2026-09-30), the
 * route's survey quality (decision 9, surveyCaveats).
 */
export function inshoreRouteCaveats(input: Omit<InshoreRouteNoticeInput, 'ntmLockBanner' | 'stateMaskOk'>): string[] {
    const out: string[] = [];
    const gaps = input.structuresUnknownCells?.length ?? 0;
    if (gaps > 0) {
        out.push(
            `Bridges and power lines not checked on ${gaps === 1 ? 'this chart' : `${gaps} of the charts on this route`} — known bridges are. Check the chart for anything overhead against your air draft before you pass under it.`,
        );
    }
    // Decision 7's limit is never drying (round 3, 2026-09-30): the route
    // stops at the edge of the bank or the land — it no longer runs on across
    // the drying ground to the pin — and says so.
    const pin = (which: 'departure' | 'destination', off: 'land' | 'drying' | undefined): void => {
        const verb = which === 'departure' ? 'starts' : 'stops';
        if (off === 'drying') {
            out.push(`Your ${which} pin is on a drying bank — the route ${verb} at its edge. It dries at low water.`);
        } else if (off === 'land') {
            out.push(`Your ${which} pin is on charted land — the route ${verb} at the water's edge.`);
        }
    };
    pin('departure', input.pinOffWater?.origin);
    // The inland-trim notice already says the destination pin is on land.
    pin('destination', input.destinationInlandTrimM ? undefined : input.pinOffWater?.destination);
    out.push(...surveyCaveats(input));
    return out;
}

export function inshoreRouteNotice(input: InshoreRouteNoticeInput): PassageNotice | null {
    const caveats = inshoreRouteCaveats(input);
    const withCaveats = (n: PassageNotice): PassageNotice =>
        caveats.length === 0 ? n : { ...n, message: `${n.message} ${caveats.join(' ')}` };
    if (!input.stateMaskOk) {
        return withCaveats({
            severity: 'warn',
            title: 'Route shown — verification incomplete',
            message:
                'The inshore router returned missing or mismatched safety classifications. The dashed amber line cannot be saved, exported or shared; retry after charts are synced.',
        });
    }
    if (input.destinationInlandTrimM) {
        return withCaveats({
            severity: 'warn',
            title: 'Destination is inland',
            message: `The pin sits ~${Math.round(input.destinationInlandTrimM)} m onto charted land — the route ends at the nearest navigable water. Drop the pin on the waterway for a berth-accurate route.`,
        });
    }
    if (input.ntmLockBanner) return withCaveats(input.ntmLockBanner);
    if (caveats.length === 0) return null;
    // Charts converted before schema 2 carry no bridge / overhead-line layers
    // (InshoreRouteResult.structuresUnknownCells): the route was not checked
    // against their charted clearances — only against the bridges Thalassa
    // lists itself, which still block. Owner decision 8 (2026-09-30): route as
    // normal and say so plainly — never refuse for it — in a skipper's words.
    const gaps = input.structuresUnknownCells?.length ?? 0;
    const offWater = !!(input.pinOffWater?.origin || input.pinOffWater?.destination);
    return {
        severity: 'warn',
        title: gaps > 0 ? 'Bridges and power lines not checked' : offWater ? 'Pin off the water' : 'Survey quality',
        message: caveats.join(' '),
    };
}

/**
 * The caveats a SAVED inshore route carries, for a plan shown again (round 3,
 * 2026-09-30): decision 8's bridges, a pin off the water and decision 9's
 * survey quality were kept with the plan (routeGeoJSON properties,
 * __inshoreRouting.caveats) but nothing showed them once the planner's banner
 * was gone. Rebuilt from the saved route's own facts when it has them — the
 * wording stays current — else the saved lines as written. Malformed saved
 * data gives none rather than breaking the page.
 */
export function savedInshoreRouteCaveats(
    plan:
        | {
              routeGeoJSON?: { properties?: unknown } | null;
              __inshoreRouting?: { status?: string; caveats?: unknown } | null;
          }
        | null
        | undefined,
): string[] {
    if (!plan) return [];
    const props = plan.routeGeoJSON?.properties;
    if (props && typeof props === 'object' && (props as { source?: unknown }).source === 'inshore-router') {
        const p = props as Record<string, unknown>;
        const strings = (v: unknown): string[] | undefined =>
            Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
        const off = p.pinOffWater as { origin?: unknown; destination?: unknown } | undefined;
        const side = (v: unknown): 'land' | 'drying' | undefined => (v === 'land' || v === 'drying' ? v : undefined);
        return inshoreRouteCaveats({
            structuresUnknownCells: strings(p.structuresUnknownCells),
            pinOffWater:
                off && typeof off === 'object'
                    ? { origin: side(off.origin), destination: side(off.destination) }
                    : undefined,
            surveyRuns: Array.isArray(p.surveyRuns) ? (p.surveyRuns as SurveyRunInfo[]) : undefined,
            surveyUncheckedCells: strings(p.surveyUncheckedCells),
        });
    }
    const saved = plan.__inshoreRouting;
    if (saved?.status === 'success' && Array.isArray(saved.caveats)) {
        return saved.caveats.filter((c): c is string => typeof c === 'string' && c.trim() !== '');
    }
    return [];
}
