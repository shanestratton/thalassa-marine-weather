/**
 * Charts stay on the boat (127-C-b): the rules that keep chart numbers and
 * positions off every disk.
 *
 * o-charts, 2026-10-10: "Storing unencrypted data on any medium, and
 * especially in the cloud, is strictly prohibited by the terms of the licenses
 * signed with the chart providers." Aboard, every depth, mark and reason is
 * still worked out and shown, in memory. What is written (localStorage, the
 * device's files, the account, a shared PDF) is the skipper's own line and
 * plain words (vision §4.1 rules 2 and 3). Each function is the boundary for
 * one store and fails closed: a chart it cannot prove open is protected.
 */
import { listRegisteredCells } from './enc/EncCellMetadata';
import { canonicalEncCellId, type EncCell } from './enc/types';
import { isProtectedChart } from './enc/chartLicence';
import { DRY_RUN_CAVEAT_PREFIX } from './routing/dryRunWords';
import { isStandingRouteNote } from './autoroutingNotes';
import { thalassaVesselWarnings } from './autoroutingVesselProfile';
import { savedInshoreRouteCaveats } from '../components/map/inshoreRouteNotice';
import { createLogger } from '../utils/createLogger';
import type { AutoroutingVesselProfile } from '../types/autorouting';
import type { SavedAutoroutingProposalEvidence } from './autoroutingProposalEvidence';
import type { TraceLegVerdict } from './routeTracer';
import type { VoyagePlan } from '../types/navigation';

export { anyProtectedChart, chartLicenceOf, isOpenChartCell, isProtectedChart } from './enc/chartLicence';

const log = createLogger('chartFacts');

/** Chart numbers and positions may be written to a disk: only with o-charts'
 *  written yes (Roberto, follow-up 3). */
export const CHART_FACTS_MAY_BE_STORED = false;
/** Shane's decision 5 (our recommendation): routes worked out on licensed
 *  charts keep saving, as a line and grade words. False denies the save. */
export const SAVE_ROUTES_FROM_LICENSED_CHARTS = true;
/** Read by Plan Your Day's Save card (127-PYD-3): the facts stay aboard. */
export const CHART_FACTS_STAY_ABOARD = true;

/**
 * The one danger wording that can NEVER be acknowledged away (Shane
 * 2026-08-10: accepted issues are good to go — "just not ones that cross
 * land though"), and the one chart reason a stored record may keep.
 * evaluateTraceRelease matches on this exact string to refuse saving a
 * land-crossing route, so it is a shared constant rather than a literal.
 */
export const TRACE_LAND_CROSSING_MESSAGE = 'crosses charted land';
const NO_GO_LEG = 'no-go leg';

export const CHART_NOTES_ABOARD =
    "Chart notes for this route were shown when it was worked out and aren't kept. Open it on the chart aboard to check it again.";
export const DRY_LINE_ABOARD = `${DRY_RUN_CAVEAT_PREFIX}: part of it dries or has water no tide clears for your boat. Open it on the chart aboard to see where.`;
export const TIDE_GATES_ABOARD =
    "Tide gates for this route need your boat's charts: recalculate it aboard to sweep departures against them.";
export const PDF_FIGURES_ABOARD =
    "Depths and marks are shown aboard in Thalassa; licensed chart figures aren't printed.";
export const LICENSED_SAVE_WAITS =
    "Saving routes worked out on licensed charts waits for o-charts' answer (expected this week). Use on the main chart to follow it now; it isn't kept.";
const REFUSED_ABOARD = "This route was refused on your boat's charts. Work it out again aboard to see why.";

type Box = [number, number, number, number];
type Pt = { lat: number; lon: number };
const meets = (a: Box, b: Box): boolean => !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);

/** Cell ids in a registry fingerprint (`id@edition@…|…`). */
export const idsFromFingerprint = (fingerprint: string): string[] =>
    fingerprint ? fingerprint.split('|').map((part) => part.split('@')[0]) : [];

/** The registry by canonical id, read once (a per-id lookup re-reads it all).
 *  A pending shelf placeholder holds no chart yet, so it decides nothing. */
const registry = (): Map<string, EncCell> =>
    new Map(listRegisteredCells().flatMap((c) => (c.usage === 'pending' ? [] : [[canonicalEncCellId(c.id), c]])));

/** Every registered protected cell under the box, navigation or not. */
export const protectedChartsUnder = (bbox: Box): EncCell[] =>
    [...registry().values()].filter((cell) => isProtectedChart(cell) && meets(cell.bbox, bbox));

/** True when facts worked out on these charts must stay in memory: any is
 *  protected, or none is known at all. */
function factsStayAboard(ids: readonly string[]): boolean {
    if (CHART_FACTS_MAY_BE_STORED) return false;
    if (ids.length === 0 || ids.some((id) => isProtectedChart({ id }))) return true;
    // Only NOAA ids are left: a stored record can still mark one protected.
    const held = registry();
    return ids.some((id) => isProtectedChart(held.get(canonicalEncCellId(id)) ?? { id }));
}

/** Whether a route's review used protected charts: its cells, and the charts its check was bound to. */
export const proposalUsedProtectedCharts = (
    cellsUsed: readonly string[] | undefined,
    registryFingerprint: string | undefined,
): boolean => factsStayAboard([...(cellsUsed ?? []), ...idsFromFingerprint(registryFingerprint ?? '')]);

/**
 * Whether a leg's charted figures may be written, for one write (the registry
 * read once). Only when at least one registered chart lies under the leg,
 * every one of them is open, and the stamp names no protected chart whose box
 * meets it. Anything unknown (a chart the stamp names that the registry no
 * longer holds, no chart at all) keeps them aboard: under 127-C-c the licensed
 * registry is memory-only and can be empty, so "nothing protected here" is
 * never read as "open".
 */
export function chartFactsKeeper(encFingerprint: string): (a: Pt, b: Pt) => boolean {
    if (CHART_FACTS_MAY_BE_STORED) return () => true;
    const held = registry();
    const open: Box[] = [];
    const closed: Box[] = [];
    for (const cell of held.values()) (isProtectedChart(cell) ? closed : open).push(cell.bbox);
    for (const id of idsFromFingerprint(encFingerprint)) {
        const cell = held.get(canonicalEncCellId(id));
        if (!cell) return () => false;
        if (isProtectedChart(cell)) closed.push(cell.bbox);
    }
    return (a, b) => {
        const box: Box = [
            Math.min(a.lon, b.lon),
            Math.min(a.lat, b.lat),
            Math.max(a.lon, b.lon),
            Math.max(a.lat, b.lat),
        ];
        // A leg's words reach past its ends (a cardinal up to 400 m off, a
        // gate mark, a nudge): a protected chart within 500 m keeps them aboard.
        const dLat = 500 / 111_320;
        const dLon = dLat / Math.max(0.01, Math.cos((a.lat * Math.PI) / 180));
        const near: Box = [box[0] - dLon, box[1] - dLat, box[2] + dLon, box[3] + dLat];
        return box.every(Number.isFinite) && open.some((c) => meets(c, box)) && !closed.some((c) => meets(c, near));
    };
}

const isLand = (v: Pick<TraceLegVerdict, 'issues'>): boolean =>
    v.issues.some((issue) => issue.severity === 'danger' && issue.message === TRACE_LAND_CROSSING_MESSAGE);

/** A leg's grade alone: display only, never a release (evaluateTraceRelease). */
export function stubLegVerdict(v: TraceLegVerdict): TraceLegVerdict {
    if (v.stub) return v;
    return {
        grade: v.grade,
        needsTide: v.needsTide,
        issues: isLand(v) ? [{ severity: 'danger', message: TRACE_LAND_CROSSING_MESSAGE }] : [],
        minDepthM: null,
        minAt: null,
        nudge: null,
        nudgeTo: null,
        stub: true,
    };
}

/** The leg-verdict bank (keys are mapHubHelpers legCacheKey): grade stubs
 *  wherever the figures must stay aboard, NOAA legs in full. */
export function chartFreeLegEntries(
    entries: ReadonlyArray<[string, TraceLegVerdict]>,
    encFingerprint: string,
): Array<[string, TraceLegVerdict]> {
    const keep = chartFactsKeeper(encFingerprint);
    return entries.map(([key, v]) => {
        const [a, b] = key.split('|').map((end) => end.split(',').map(Number));
        const ok = b?.length === 2 && a.length === 2 && keep({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] });
        return [key, ok ? v : stubLegVerdict(v)];
    });
}

/** A route check's danger legs: the land words, else "no-go leg". */
export function chartFreeOutcomeLegs<T extends { message: string }>(legs: T[], encFingerprint: string): T[] {
    if (!factsStayAboard(idsFromFingerprint(encFingerprint))) return legs;
    let changed = false;
    const out = legs.map((leg) => {
        if (leg.message === TRACE_LAND_CROSSING_MESSAGE || leg.message === NO_GO_LEG) return leg;
        changed = true;
        return { ...leg, message: NO_GO_LEG };
    });
    return changed ? out : legs;
}

/** Her own words on an Auto route: what it is, how it was routed (her draft),
 *  what Thalassa says about her boat. */
let ownWords: Set<string> | null = null;
const isOwnWords = (line: string): boolean => {
    ownWords ??= new Set([
        ...thalassaVesselWarnings(undefined),
        ...thalassaVesselWarnings({
            draftStatus: 'estimated',
            airDraft: { status: 'estimated' },
        } as AutoroutingVesselProfile),
    ]);
    return isStandingRouteNote(line) || ownWords.has(line);
};

/**
 * Saved proposal evidence over protected charts (C8): each leg's grade, her
 * own words and one fixed chart-notes line. The shape stays valid for
 * normaliseAutoroutingProposalEvidence and the server CHECK, so no migration.
 * Returns the same object when nothing would change.
 */
export function chartFreeEvidence(
    evidence: SavedAutoroutingProposalEvidence,
    cellsUsed?: readonly string[],
): SavedAutoroutingProposalEvidence {
    if (!evidence.providerCheck && !proposalUsedProtectedCharts(cellsUsed, evidence.basis.registryFingerprint))
        return evidence;
    const warnings = [
        ...evidence.warnings.filter((w) => w !== CHART_NOTES_ABOARD && isOwnWords(w)),
        CHART_NOTES_ABOARD,
    ];
    if (
        !evidence.providerCheck &&
        warnings.length === evidence.warnings.length &&
        warnings.every((w, i) => w === evidence.warnings[i]) &&
        evidence.legs.every((leg) => leg.minDepthM === null && leg.minAt === null && leg.issues.length === 0)
    )
        return evidence;
    const { providerCheck: _provider, ...rest } = evidence;
    return {
        ...rest,
        warnings,
        legs: evidence.legs.map(({ grade, incomplete }) => ({
            grade,
            incomplete,
            minDepthM: null,
            minAt: null,
            issues: [],
        })),
    };
}

/** What a stored voyage plan keeps of its route's properties. Anything not
 *  listed is dropped, so a fact added later stays off the disk by default. */
const KEPT_PROPERTIES = [
    'source',
    'distanceNM',
    'cellsUsed',
    'structuresUnknownCells',
    'pinOffWater',
    'tideCheck',
    'waterPack',
    '_source',
    'legGrades',
    'traceVerification',
];
/** The router's chart facts: their presence alone means a plan came from charts. */
const CHART_FACT_PROPERTIES = [
    'shallowRuns',
    'dryRuns',
    'surveyRuns',
    'surveyUncheckedCells',
    'nearShallow',
    'nearShallowSpans',
    'pinTail',
    'destinationInlandTrimM',
];
const present = (v: unknown): boolean => v !== undefined && (!Array.isArray(v) || v.length > 0);
/** A chart figure in a line: a depth or distance, or a position. */
const CHART_FIGURE = /\d\s?k?m\b|°/;

/**
 * A voyage plan for the disk and the Log (C10 stores 3 and 4). Over protected
 * charts, and whenever chart facts are present with no charts named, it keeps
 * the line, its distance and number-free notes, marked `chartFacts:
 * 'aboard-only'` so no reader takes a missing tide gate for a clear one. The
 * full plan stays in memory. Returns the same object when nothing changes
 * (null too: the planner's reset saves null).
 */
export function chartFreeVoyagePlan(plan: VoyagePlan): VoyagePlan {
    if (!plan) return plan;
    const geo = plan.routeGeoJSON;
    const props = (geo?.properties ?? {}) as Record<string, unknown>;
    const routing = plan.__inshoreRouting;
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    const caveats = strings(routing?.caveats);
    const refusal = typeof routing?.error === 'string' && /\d/.test(routing.error);
    if (
        props.source !== 'inshore-router' &&
        props.chartFacts !== 'aboard-only' &&
        !CHART_FACT_PROPERTIES.some((k) => props[k] !== undefined) &&
        caveats.length === 0 &&
        !refusal
    )
        return plan;
    const cells = strings(Array.isArray(props.cellsUsed) ? props.cellsUsed : routing?.cellsUsed);
    if (cells.length > 0 ? !factsStayAboard(cells) : CHART_FACTS_MAY_BE_STORED) return plan;

    const kept: Record<string, unknown> = {};
    for (const k of KEPT_PROPERTIES) if (props[k] !== undefined) kept[k] = props[k];
    const off = props.pinOffWater as Record<string, unknown> | undefined;
    if (off && typeof off === 'object') {
        const side = (v: unknown) => (v === 'land' || v === 'drying' || v === 'no-tide' ? v : undefined);
        kept.pinOffWater = Object.fromEntries(
            (['origin', 'destination'] as const).filter((end) => side(off[end])).map((end) => [end, off[end]]),
        );
    }
    const dry =
        present(props.dryRuns) ||
        props.dryStretches === true ||
        caveats.some((c) => c.startsWith(DRY_RUN_CAVEAT_PREFIX));
    // Her lines with no chart figure in them, then lines rebuilt from the kept
    // facts alone, by the same words a plan shown again uses.
    const words = caveats.filter(
        (c) => c !== CHART_NOTES_ABOARD && !c.startsWith(DRY_RUN_CAVEAT_PREFIX) && !CHART_FIGURE.test(c),
    );
    for (const c of savedInshoreRouteCaveats({ routeGeoJSON: { properties: { ...kept, source: 'inshore-router' } } }))
        if (!words.includes(c)) words.push(c);
    const dropped =
        refusal ||
        CHART_FACT_PROPERTIES.some((k) => present(props[k])) ||
        caveats.some((c) => c === CHART_NOTES_ABOARD || (c !== DRY_LINE_ABOARD && !words.includes(c)));
    kept.chartFacts = 'aboard-only';
    if (dry) kept.dryStretches = true;
    // Whether it had tide gates at all, never where (the departure planner).
    if (present(props.shallowRuns) || props.tideGates === true) kept.tideGates = true;
    const lines = [...(dry ? [DRY_LINE_ABOARD] : []), ...words, ...(dropped ? [CHART_NOTES_ABOARD] : [])];
    let out: VoyagePlan['__inshoreRouting'] = routing;
    if (routing) {
        const { caveats: _old, ...rest } = routing;
        out = {
            ...rest,
            ...(refusal ? { error: REFUSED_ABOARD } : {}),
            ...(routing.status === 'success' && lines.length > 0 ? { caveats: lines } : {}),
        };
    }
    // Already number-free (a boot load, a re-save): the same object.
    const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
    if ((!geo || same(kept, props)) && same(out, routing)) return plan;
    return {
        ...plan,
        ...(geo ? { routeGeoJSON: { ...geo, properties: kept } } : {}),
        ...(routing ? { __inshoreRouting: out } : {}),
    };
}

/**
 * Once per launch (127-C-b): the older leg-verdict banks (v1-v4, which held
 * charted depths and positions) are removed for every account, and stored
 * route-check findings over licensed charts are rewritten number-free. Counts
 * only are logged.
 */
export function purgeChartFactsOnDisk(): number {
    let made = 0;
    const keys: string[] = [];
    try {
        for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i) ?? '');
    } catch {
        return 0;
    }
    for (const key of keys) {
        try {
            if (/^thalassa_leg_verdicts_v[1-4](::|$)/.test(key)) {
                localStorage.removeItem(key);
                made++;
            } else if (key.startsWith('thalassa_trace_check_outcomes_v1')) {
                const all = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<
                    string,
                    { legs?: Array<{ message: string }>; encFingerprint?: unknown }
                >;
                let changed = false;
                for (const record of Object.values(all)) {
                    if (!Array.isArray(record?.legs)) continue;
                    const legs = chartFreeOutcomeLegs(record.legs, String(record.encFingerprint ?? ''));
                    if (legs === record.legs) continue;
                    record.legs = legs;
                    changed = true;
                    made++;
                }
                if (changed) localStorage.setItem(key, JSON.stringify(all));
            }
        } catch {
            /* one unreadable record never stops the rest */
        }
    }
    if (made > 0) log.warn(`chart facts: ${made} records made number-free`);
    return made;
}
