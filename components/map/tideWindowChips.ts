/**
 * Phase 7 tide-window chips — "clears 09:40–15:10 ≈" on the route's
 * needs-tide runs.
 *
 * The inshore engine ships charted-shallow caution runs with their real charted
 * min depth (RouteResult.shallowRuns, from grid.shallowDepthM). This module
 * turns each of those runs into a map chip at the run midpoint, computed
 * against the cached WorldTides extremes curve (LAT, half-cosine interp) via
 * the shipped computeTidalWindows maths.
 *
 * Owner decision 10 (Shane, 2026-09-30: "Amber if a tide clears it"): the
 * same curves decide the route line's colour. A curve's top over the whole
 * loaded span (curveHighestM — WorldTides sends no highest astronomical
 * tide; the 14 days the rest of the app loads) is the highest tide the app
 * knows in its 0.25° bucket: a stretch whose rise is within it is amber, its
 * chip the window; one that needs more ("no tide in 14 days clears it —
 * needs +4.9 m, highest 2.5 m") is red and anchors on its shallowest spot;
 * with no curve at all it is red with "no tide data — needs +1.4 m"
 * (fail-safe), and where no curve was loaded for its place, "tide times not
 * loaded here". A run red for more than depth (decision-1 water, a hazard's
 * buffer, water no chart covers, the canal) says why, with or without a
 * curve. The chip's colour is the line's (tideRunChips tone), and every amber
 * stretch has a chip. annotateTideWindows hands the tops back (onTide) so
 * the planner redraws the line in them.
 *
 * Doctrine (masterplan §5, enforced in review): tide changes FEASIBILITY AND
 * TIMING, never geometry or preference — this file is display-only and runs
 * AFTER the route has rendered, off the compute path. One exception, owner
 * decision 11 (2026-10-01): water NO tide the app knows clears for the boat
 * is impassable to the router (services/engine/tideCeiling), which reads the
 * same curves before it routes (services/routing/tideCeilings).
 *
 * Field rules honoured here:
 *  - ONE tide-curve fetch per 0.25° bucket of the tide cache, at most
 *    MAX_TIDE_CURVES per route, the buckets holding the most shallow water
 *    first (the direct WorldTides fallback is rate-limited to 10/hr, and
 *    the cache's own buckets are what the pi cache shares). Round-4 review
 *    (2026-09-30): one curve at the longest run's midpoint coloured every
 *    stretch of the route — a river-mouth bank 25 km from Bramble Bay was
 *    drawn from Bramble Bay's top. A stretch in a bucket with no curve stays
 *    red.
 *  - minDepthM === null (uncharted/conflict caution) NEVER gets a window — a
 *    number computed from nothing would be fabricated confidence.
 *  - Zero windows with a curve that doesn't COVER the horizon is a data gap,
 *    not "never clears" — the run's colour still comes from the curve's top,
 *    and its chip says "tide times not loaded" (decision 10, 2026-09-30: it
 *    used to get no chip, only a console line).
 *  - Chips key off the router's charted-shallow runs (shallowRuns with a
 *    charted depth — caution by construction, or the backstop's charted-shallow
 *    stretches), NOT the rendered colour (fix-up, 2026-09-30). Keyed on
 *    rendered 'danger', a charted-shallow run under a yellow marked channel
 *    never grew a chip: marks say where the channel is, not how deep it is.
 *    (The NtM-lock skip went with the 'ntmlock' state, which nothing has
 *    produced since the lock UI was removed on 2026-07-02 — round-3 review,
 *    2026-09-30.)
 *  - An endpoint tail through decision-1 water (coarserLandPaint) gets no
 *    window — its finest survey charts it deep enough — but a plain label
 *    naming the coarser chart's land paint and the finest survey's depth.
 *  - Survey stretches (owner decision 9, 2026-09-30: amber dashes on the route) get
 *    "survey ±2.2 m" / "old or ungraded survey" — ONE chip per
 *    stretch: on a tide chip the stretch overlaps, after its window (the
 *    more serious reason first), else a chip of their own. No tide curve is
 *    needed for them, so they survive a curve that never arrives.
 *  - CapacitorHttp ignores AbortSignal on device: the fetch is bounded with
 *    withTimeout, never trusted to time out on its own.
 */
import mapboxgl from 'mapbox-gl';
import { fetchTideCurve, TIDE_CURVE_MAX_DAYS, tideCurveBucket, type TideCurve } from '../../services/TideHeightService';
import { tideFieldFromCurve } from '../../services/routing/env/EnvFields';
import { computeTidalWindows, DEFAULT_TIDE_SAFETY_M } from '../../services/routing/tidalWindow';
import { AMBER_SURVEY_REASONS, type ShallowRunInfo, type SurveyRunInfo } from '../../services/engine/types';
import { withTimeout } from '../../utils/deadline';
import { createLogger } from '../../utils/createLogger';
import { NEEDS_TIDE_AMBER, tideTopAlong, tideTopSpots, type InshoreRoutePiece } from './inshoreRouteState';
import { haversineM } from '../../services/engine/geometry';
import {
    curveHighestM,
    curveSpanDays,
    ROUTE_TIDE_CURVES_MAX,
    TIDE_WINDOW_HORIZON_MS,
} from '../../services/tides/curveHighest';

// The curve's top and span live with the tide service's pure helpers (owner
// decision 11, 2026-10-01: the router reads them BEFORE routing — services/
// routing/tideCeilings); re-exported so the chips keep one import.
export { curveHighestM, curveSpanDays };

const log = createLogger('tideWindow');

// The window search horizon from departure — the router's tide ceilings
// fetch the same window, so both read one cache entry (one constant since
// the decision 11 fix-up, 2026-10-01).
const HORIZON_MS = TIDE_WINDOW_HORIZON_MS;
const CURVE_FETCH_TIMEOUT_MS = 12_000;

/** The most tide curves one route fetches (one per 0.25° bucket). */
export const MAX_TIDE_CURVES = ROUTE_TIDE_CURVES_MAX;

/** A chip never grows wider than this: longer words wrap (round-3 review,
 * 2026-09-30 — a one-line 11 px pill ran ~450–600 px wide with its survey
 * words, off a 375–430 pt phone screen). */
export const CHIP_MAX_WIDTH_PX = 220;

/** A chip's colour is the colour of the line it names (owner decision 10,
 *  2026-09-30): amber for water a tide clears (and survey words), red for
 *  water none does, no tide data, or charts that disagree. */
export type ChipTone = 'amber' | 'red';

/** The route's danger red, for the text of a red chip (the line is #ff1744). */
const CHIP_RED = '#ff8a80';

/** A chip, styled inline (Tailwind can't see runtime-created elements). */
export function chipElement(text: string, tone: ChipTone = 'amber'): HTMLDivElement {
    const el = document.createElement('div');
    el.textContent = text;
    Object.assign(el.style, {
        background: 'rgba(15, 23, 42, 0.92)',
        border: tone === 'red' ? '1px solid rgba(255, 23, 68, 0.55)' : '1px solid rgba(255, 145, 0, 0.5)',
        color: tone === 'red' ? CHIP_RED : NEEDS_TIDE_AMBER,
        borderRadius: '10px',
        padding: '2px 9px',
        fontSize: '11px',
        fontWeight: '600',
        lineHeight: '1.3',
        whiteSpace: 'normal',
        maxWidth: `${CHIP_MAX_WIDTH_PX}px`,
        width: 'max-content',
        textAlign: 'center',
        pointerEvents: 'none',
        boxShadow: '0 1px 4px rgba(0,0,0,0.5)',
    } satisfies Partial<CSSStyleDeclaration>);
    return el;
}

function fmtHM(ms: number): string {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export interface TideChipOptions {
    map: mapboxgl.Map;
    runs: readonly ShallowRunInfo[];
    /** Vessel draft in METRES (caller converts — vessel.draft is stored in feet). */
    draftM: number;
    /** Departure time (ms epoch) — the window horizon start. */
    departureMs: number;
    /** True ⇒ a newer compute superseded this one; never touch the map. */
    isStale: () => boolean;
    /** Marker sink — the CALLER owns removal (route clear / next compute). */
    markers: mapboxgl.Marker[];
    /** The route's survey stretches (owner decision 9) — see routeChipPlan. */
    surveyRuns?: readonly SurveyRunInfo[];
    /** Draft + UKC the router judged the water against (RouteResult.tideNeedM);
     *  the windows are worked against the same sum. Default: draftM +
     *  DEFAULT_TIDE_SAFETY_M. */
    needM?: number;
    /** The stretches some tide could draw amber (inshoreRouteState
     *  tideLiftablePieces) — known before any curve. Where the tide is read
     *  (one curve per bucket they lie in), and which runs are red whatever
     *  the tide (owner decision 10). */
    liftable?: readonly TidePiece[];
    /** Per segment: the canal (RouteResult.canalMask) — its red is not the
     *  tide's to lift, and its chip says so. */
    canalMask?: readonly boolean[];
    /** The highest tide the app knows at a spot (curveHighestM of the curve
     *  loaded for its bucket, null where none was), once the curves are in —
     *  the planner redraws the line in it (owner decision 10) and hands back
     *  the pieces it drew, which the chips are worked from. Not called
     *  without a curve: the line is already red. */
    onTide?: (highestAt: (lon: number, lat: number) => number | null) => readonly InshoreRoutePiece[] | void;
    /** The clock the tops are read from, with the departure (fix-up,
     *  2026-10-01); default now. */
    nowMs?: number;
}

/**
 * Which runs get a chip (pure; fix-up 2026-09-30): `windowed` — a charted
 * depth to compute a tide window from; `landPaint` — decision-1 water (an
 * endpoint tail, or mid-route since the round-3 review), named instead. The
 * rendered colour is not asked.
 */
export function tideChipRuns(runs: readonly ShallowRunInfo[]): {
    windowed: ShallowRunInfo[];
    landPaint: ShallowRunInfo[];
} {
    return {
        // uncharted — no fabricated windows
        windowed: runs.filter((r) => r.minDepthM !== null),
        landPaint: runs.filter((r) => r.minDepthM === null && r.coarserLandPaint && r.finestDepthM !== undefined),
    };
}

/** The label of a decision-1 chip (owner decisions 1 and 7), in words a
 * punter reads in one second. Round 3 (2026-09-30) made it "Charts disagree —
 * detailed survey shows N m, another chart shows land"; at ~70 characters
 * that ran off a phone screen on the map (round-3 review), so the chip says
 * it short and the route notice says the rest. */
export function coarserLandPaintLabel(run: ShallowRunInfo): string {
    const d = run.finestDepthM ?? 0;
    return `Charts disagree · ${Number.isInteger(d) ? d.toFixed(0) : d.toFixed(1)} m charted`;
}

/** What a survey stretch adds to a chip (owner decision 9, 2026-09-30), or
 * null for a reason that is never amber ('survey-unchecked': a caveat). The
 * margin is "survey ±1.0 m" since the round-4 review (2026-09-30): "survey
 * may be out by 1.0 m" after a tide reason wrapped a 220 px chip to four
 * lines; the route notice keeps the long words. */
export function surveyChipLabel(run: Pick<SurveyRunInfo, 'reason' | 'errorM'>): string | null {
    if (run.reason === 'survey-margin') return `survey ±${(run.errorM ?? 0).toFixed(1)} m`;
    if (run.reason === 'survey-poor' || run.reason === 'survey-ungraded') return 'old or ungraded survey';
    return null;
}

/** Survey reasons, most serious first (the lead overlay's order). */
const SURVEY_ORDER = ['survey-poor', 'survey-margin', 'survey-ungraded'] as const;

/** Below this a survey stretch with no tide chip to ride gets no chip of its
 * own (its amber still shows) — the shallow runs' chip threshold. */
const SURVEY_CHIP_MIN_M = 200;

export interface RouteChipPlan {
    /** Tide-window runs, each with the survey words its chip adds. */
    windowed: { run: ShallowRunInfo; survey: string[] }[];
    /** Decision-1 tails, each with the survey words its chip adds. */
    landPaint: { run: ShallowRunInfo; survey: string[] }[];
    /** Survey stretches no tide chip carries: a chip of their own. */
    survey: { lat: number; lon: number; labels: string[] }[];
}

/**
 * Which chips the route gets (pure; owner decision 9, 2026-09-30): the tide
 * chips of tideChipRuns, and the amber survey stretches — runs that touch
 * merged into one stretch — each said ONCE: after the window on every tide
 * chip whose run it overlaps (the tide reason is the more serious), else on
 * a chip of its own at its longest run's midpoint.
 */
export function routeChipPlan(
    runs: readonly ShallowRunInfo[],
    surveyRuns: readonly SurveyRunInfo[] | undefined,
): RouteChipPlan {
    const { windowed, landPaint } = tideChipRuns(runs);
    const amber = (Array.isArray(surveyRuns) ? surveyRuns : [])
        .filter((r) => r && AMBER_SURVEY_REASONS.has(r.reason))
        .map((r) => ({ r, a: r.startSeg + r.startT, b: r.endSeg + r.endT }))
        .filter((x) => Number.isFinite(x.a) && Number.isFinite(x.b) && x.b > x.a)
        .sort((x, y) => x.a - y.a);
    // Stretches: runs that touch or overlap, merged.
    const stretches: { a: number; b: number; runs: SurveyRunInfo[] }[] = [];
    for (const x of amber) {
        const last = stretches[stretches.length - 1];
        if (last && x.a <= last.b + 1e-9) {
            last.b = Math.max(last.b, x.b);
            last.runs.push(x.r);
        } else stretches.push({ a: x.a, b: x.b, runs: [x.r] });
    }
    const labelsOf = (rs: readonly SurveyRunInfo[]): string[] => {
        const out: string[] = [];
        for (const reason of SURVEY_ORDER) {
            const of = rs.filter((r) => r.reason === reason);
            if (of.length === 0) continue;
            const worst = of.reduce((m, r) => ((r.errorM ?? 0) > (m.errorM ?? 0) ? r : m));
            const label = surveyChipLabel(worst);
            if (label && !out.includes(label)) out.push(label);
        }
        return out;
    };
    const withSurvey = (run: ShallowRunInfo) => ({ run, survey: [] as string[] });
    const tide = [...windowed.map(withSurvey), ...landPaint.map(withSurvey)];
    const survey: RouteChipPlan['survey'] = [];
    for (const st of stretches) {
        const labels = labelsOf(st.runs);
        if (labels.length === 0) continue;
        let carried = false;
        for (const t of tide) {
            // A shallow run covers its segments whole: [startSeg, endSeg + 1].
            if (Math.min(st.b, t.run.endSeg + 1) - Math.max(st.a, t.run.startSeg) <= 1e-9) continue;
            for (const l of labels) if (!t.survey.includes(l)) t.survey.push(l);
            carried = true;
        }
        if (carried) continue;
        const lengthM = st.runs.reduce((m, r) => m + r.lengthM, 0);
        if (lengthM < SURVEY_CHIP_MIN_M) continue;
        const anchor = st.runs.reduce((m, r) => (r.lengthM > m.lengthM ? r : m));
        survey.push({ lat: anchor.midLat, lon: anchor.midLon, labels });
    }
    return {
        windowed: tide.slice(0, windowed.length),
        landPaint: tide.slice(windowed.length),
        survey,
    };
}

/** A chip's words: its own reason first, then the survey's. */
const joinChip = (first: string, survey: readonly string[]): string => [first, ...survey].join(' · ');

/** A chip to place: where, what it says, and the colour of the line it names. */
export interface RouteChip {
    lat: number;
    lon: number;
    text: string;
    tone: ChipTone;
}

const fmtM = (m: number): string => `${m.toFixed(1)} m`;
const fmtDepth = (d: number): string => (Number.isInteger(d) ? d.toFixed(0) : d.toFixed(1));

/** The drawn needs-tide pieces a chip plan reads (inshoreRoutePieces). */
type TidePiece = Pick<InshoreRoutePiece, 'state' | 'coordinates' | 'u0' | 'u1' | 'depthM'>;

/** Metres along a piece's coordinates. */
function coordsM(c: readonly (readonly [number, number])[]): number {
    let m = 0;
    for (let i = 1; i < c.length; i++) m += haversineM(c[i - 1][1], c[i - 1][0], c[i][1], c[i][0]);
    return m;
}

/** The point halfway along a piece, by length. */
function midpointOf(c: readonly (readonly [number, number])[]): [number, number] {
    const half = coordsM(c) / 2;
    let acc = 0;
    for (let i = 1; i < c.length; i++) {
        const m = haversineM(c[i - 1][1], c[i - 1][0], c[i][1], c[i][0]);
        if (acc + m >= half) {
            const f = m > 0 ? (half - acc) / m : 0;
            return [c[i - 1][0] + (c[i][0] - c[i - 1][0]) * f, c[i - 1][1] + (c[i][1] - c[i - 1][1]) * f];
        }
        acc += m;
    }
    return [c[0][0], c[0][1]];
}

const longestOf = <P extends TidePiece>(ps: readonly P[]): P =>
    ps.reduce((a, b) => (coordsM(b.coordinates) > coordsM(a.coordinates) ? b : a));

/**
 * The tide curves loaded for a route, by place (round-4 review, 2026-09-30):
 * one per 0.25° bucket of the tide cache (TideHeightService tideCurveBucket).
 */
export interface RouteTideCurves {
    /** The curve loaded for a spot's bucket, or null. */
    at(lon: number, lat: number): TideCurve | null;
    /** How many were loaded: none is 'no tide data'; some, but not a spot's,
     *  is 'tide times not loaded here'. */
    count: number;
}

/** The curves by bucket, as the chips read them (pure). */
export function routeTideCurves(byBucket: ReadonlyMap<string, TideCurve>): RouteTideCurves {
    return { at: (lon, lat) => byBucket.get(tideCurveBucket(lat, lon)) ?? null, count: byBucket.size };
}

/** One curve for the whole route, or none. */
const oneCurve = (curve: TideCurve | null): RouteTideCurves => ({ at: () => curve, count: curve ? 1 : 0 });

/**
 * Where a route's tide curves are fetched (pure; round-4 review,
 * 2026-09-30): one spot per 0.25° bucket of the tide cache, in the buckets
 * that hold the most shallow water first, at most `max` of them. Read at
 * every chip run's shallowest spot and along every stretch some tide could
 * draw amber, at the spots its colour is read at (tideTopSpots) — so every
 * bucket the line's colour asks about is asked for, up to the cap. A stretch
 * in a bucket past the cap stays red, "tide times not loaded here".
 */
export function tideFetchPlan(
    runs: readonly ShallowRunInfo[],
    liftable: readonly TidePiece[],
    max = MAX_TIDE_CURVES,
): { bucket: string; lat: number; lon: number }[] {
    const buckets = new Map<string, { lat: number; lon: number; weight: number; best: number }>();
    const add = (lon: number, lat: number, m: number): void => {
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
        const key = tideCurveBucket(lat, lon);
        const b = buckets.get(key);
        if (!b) buckets.set(key, { lat, lon, weight: m, best: m });
        else {
            b.weight += m;
            if (m > b.best) Object.assign(b, { lat, lon, best: m });
        }
    };
    for (const run of runs) add(run.minAtLon ?? run.midLon, run.minAtLat ?? run.midLat, run.lengthM);
    for (const p of liftable) {
        const spots = tideTopSpots(p.coordinates);
        const each = spots.length > 0 ? coordsM(p.coordinates) / spots.length : 0;
        for (const [lon, lat] of spots) add(lon, lat, each);
    }
    return [...buckets]
        .sort((a, b) => b[1].weight - a[1].weight)
        .slice(0, Math.max(0, max))
        .map(([bucket, b]) => ({ bucket, lat: b.lat, lon: b.lon }));
}

/**
 * Words for water no tide the app knows clears (owner decision 10; round-4
 * review, 2026-09-30): the rise it needs and the top of the tide over the
 * days loaded. Never "never clears": at neaps a 3-day curve said that of
 * water next week's springs clear — the top is only as long as the curve.
 */
export function noTideClearsWords(riseM: number, highestM: number, days: number): string {
    return `no tide in ${days} day${days === 1 ? '' : 's'} clears it — needs +${fmtM(riseM)}, highest ${fmtM(highestM)}`;
}

/**
 * Words for the shallow end of a band some tide clears elsewhere (decision 11
 * fix-up, 2026-10-01): its charted shallowest needs more than the highest
 * tide, but its deepest charted value plus that tide reaches what the keel
 * needs — "charted 0–2 m: its 0 m end needs +2.9 m, highest 2.5 m — check
 * the chart". Still red (decision 10); never "no tide clears it", which the
 * router reserves for water it proved and will not route through (decision
 * 11) — the skipper saw the router take water the chip said no tide clears.
 * Without a deeper charted value, or where none reaches, noTideClearsWords.
 */
export function shallowEndWords(
    depthM: number,
    deepestM: number | undefined,
    riseM: number,
    highestM: number,
    days: number,
): string {
    if (deepestM === undefined || !(deepestM > depthM) || deepestM + highestM < depthM + riseM - 1e-9)
        return noTideClearsWords(riseM, highestM, days);
    return `charted ${fmtDepth(depthM)}–${fmtDepth(deepestM)} m: its ${fmtDepth(depthM)} m end needs +${fmtM(riseM)}, highest ${fmtM(highestM)} — check the chart`;
}

/**
 * A pin's red dry tail's chip (package 125-05b; ShallowRunInfo.dryTail): the
 * ground it crosses, in a second — "dries 0.4 m to the pin". Red whatever the
 * tide; the route notes say when the boat floats over it.
 */
export function dryTailChipWords(run: Pick<ShallowRunInfo, 'minDepthM'>): string {
    const d = run.minDepthM;
    if (d === null) return 'dry ground to the pin — check the chart';
    return d < 0 ? `dries ${fmtM(-d)} to the pin` : `${fmtDepth(d)} m charted · no tide clears it`;
}

/**
 * Why a shallow run is red whatever the tide (round-4 review, 2026-09-30),
 * in a punter's words — the router's own reason (ShallowRunInfo
 * chartsDisagree / nearHazard / partUncharted, the canal), never "red for
 * more than depth".
 */
export function redReasonWords(
    run: Pick<ShallowRunInfo, 'chartsDisagree' | 'nearHazard' | 'partUncharted' | 'minDepthM' | 'finestDepthM'>,
    inCanal = false,
): string {
    const d = run.minDepthM ?? run.finestDepthM ?? null;
    const charted = d !== null ? ` · ${fmtDepth(d)} m charted` : '';
    if (run.chartsDisagree) return `Charts disagree${charted}`;
    if (run.nearHazard) return 'charted hazard close by — check the chart';
    if (run.partUncharted) return 'part not charted — check the chart';
    if (inCanal) return `canal${charted}`;
    return 'check the chart here';
}

/** Amber stretches closer than this along the line share one chip. */
const AMBER_CHIP_MERGE_M = 500;

/**
 * The tide chips of a route (pure; owner decision 10, 2026-09-30), from its
 * chip plan and the tide curves — one per place (`curves`, round-4 review,
 * 2026-09-30), or one for the whole route (`curve`), or none. Each windowed
 * run gets its chip, its survey words after its own:
 *   • water some tide clears — AMBER, on the amber: the first window in 24 h
 *     ("clears 09:40–15:10 ≈"), "needs +2.4 m — no window in 24 h", or,
 *     when the curve does not cover the day, "needs +1.4 m — tide times not
 *     loaded";
 *   • water no tide the app knows clears — RED: "no tide in 14 days clears
 *     it — needs +4.9 m, highest 2.5 m", on the run's shallowest spot;
 *   • no curve at all — RED: "no tide data — needs +1.4 m"; a curve, but none
 *     for this place — RED: "tide times not loaded here — needs +1.4 m";
 *   • a run no tide could draw amber (`liftable` has none of it: decision-1
 *     water, a hazard's buffer, water no chart covers, the canal) — RED,
 *     saying why ("Charts disagree · 2 m charted"), curve or no curve.
 * With the drawn line (`pieces`) every chip names the colour under it: a run
 * holding both colours gets a red chip for its red (its shallowest spot, or
 * why part of it is red) and an amber chip for its amber, the window worked
 * from the amber's own shallowest depth. Every amber stretch gets a chip:
 * one outside every run (under a chip's 200 m) gets its own, stretches
 * within 500 m sharing one. The survey words ride the run's first chip only
 * (one chip per stretch). A run the keel clears at any tide says only its
 * survey words (if any). `tideSafetyM` is the UKC the line was drawn with.
 */
export function tideRunChips(input: {
    plan: RouteChipPlan;
    curve?: TideCurve | null;
    curves?: RouteTideCurves;
    draftM: number;
    departureMs: number;
    tideSafetyM?: number;
    pieces?: readonly TidePiece[];
    liftable?: readonly TidePiece[];
    canalMask?: readonly boolean[];
    /** The clock (fix-up, 2026-10-01): a curve's top is read from the later
     *  of this and the departure on — never a tide that has happened. The
     *  planner passes now; absent, the departure. */
    nowMs?: number;
}): { chips: RouteChip[]; placed: string[] } {
    const { plan, draftM, departureMs } = input;
    const fromMs = Math.max(input.nowMs ?? departureMs, departureMs);
    const tideSafetyM = input.tideSafetyM ?? DEFAULT_TIDE_SAFETY_M;
    const needM = draftM + tideSafetyM;
    const curves = input.curves ?? oneCurve(input.curve ?? null);
    const chips: RouteChip[] = [];
    const placed: string[] = [];
    const untilMs = departureMs + HORIZON_MS;
    type Tide = { curve: TideCurve; highestM: number; field: NonNullable<ReturnType<typeof tideFieldFromCurve>> };
    const memo = new Map<TideCurve, Tide | null>();
    /** The tide loaded for a spot: its curve, top and field — or null. */
    const tideAt = (lon: number, lat: number): Tide | null => {
        const curve = curves.at(lon, lat);
        if (!curve) return null;
        if (!memo.has(curve)) {
            const highestM = curveHighestM(curve, fromMs);
            const field = highestM !== null ? tideFieldFromCurve(curve) : null;
            memo.set(curve, highestM !== null && field ? { curve, highestM, field } : null);
        }
        return memo.get(curve) ?? null;
    };
    /** The lowest top along a stretch (the line's own rule), and the days it spans. */
    const topAlong = (coords: readonly (readonly [number, number])[]): { top: number; days: number } | null => {
        let days = Infinity;
        const top = tideTopAlong(
            {
                depthM: null,
                needM,
                highestM: null,
                highestAt: (lon, lat) => {
                    const t = tideAt(lon, lat);
                    if (t) days = Math.min(days, curveSpanDays(t.curve, fromMs));
                    return t ? t.highestM : null;
                },
            },
            coords,
        );
        return top === null ? null : { top, days: Number.isFinite(days) ? days : 1 };
    };
    const tidePieces = (input.pieces ?? []).filter((p) => p.state === 'tide' && typeof p.depthM === 'number');
    const redPieces = (input.pieces ?? []).filter((p) => p.state === 'danger');
    const liftable = input.liftable?.filter((p) => typeof p.depthM === 'number');
    /** The pieces inside a run. */
    const inRunOf = <P extends TidePiece>(run: ShallowRunInfo, ps: readonly P[]): P[] => {
        const u0 = run.startSeg + (run.startT ?? 0);
        const u1 = run.endSeg + (run.endT ?? 1);
        return ps.filter((p) => p.u1 > u0 + 1e-9 && p.u0 < u1 - 1e-9);
    };
    const inCanal = (run: ShallowRunInfo): boolean => {
        const m = input.canalMask;
        if (!m) return false;
        for (let s = run.startSeg; s <= run.endSeg; s++) if (m[s]) return true;
        return false;
    };
    /** A window chip's words for a charted depth some tide clears. */
    const windowWords = (depth: number, tide: Tide): string => {
        const riseM = needM - depth;
        const res = computeTidalWindows({
            minDepthM: depth,
            draftM,
            tideSafetyM,
            tide: tide.field,
            fromMs: departureMs,
            untilMs,
        });
        if (res.windows.length > 0) {
            const w = res.windows[0];
            const approx = w.approx ? ' ≈' : '';
            return w.openMs <= departureMs
                ? `clears until ${fmtHM(w.closeMs)}${approx}`
                : `clears ${fmtHM(w.openMs)}–${fmtHM(w.closeMs)}${approx}`;
        }
        // No window: none in the day, or — a data gap, NOT "never clears" —
        // the curve does not cover the day.
        const [c0, c1] = tide.field.coverage();
        return c0 <= departureMs && c1 >= untilMs
            ? `needs +${fmtM(riseM)} — no window in 24 h`
            : `needs +${fmtM(riseM)} — tide times not loaded`;
    };
    const notLoaded = (riseM: number): string =>
        curves.count === 0
            ? `no tide data — needs +${fmtM(riseM)}`
            : `tide times not loaded here — needs +${fmtM(riseM)}`;
    /** The amber chip for drawn needs-tide pieces: the window from their own shallowest depth. */
    const amberChip = (ps: readonly TidePiece[]): RouteChip => {
        const depth = ps.reduce((m, p) => Math.min(m, p.depthM as number), Infinity);
        const [lon, lat] = midpointOf(longestOf(ps).coordinates);
        const tide = tideAt(lon, lat);
        return {
            lon,
            lat,
            text: tide ? windowWords(depth, tide) : `needs +${fmtM(needM - depth)} — tide times not loaded`,
            tone: 'amber',
        };
    };
    const chipped = new Set<TidePiece>();
    for (const { run, survey } of plan.windowed) {
        // A pin's dry tail: red, by what it dries (125-05b).
        if (run.dryTail) {
            const text = joinChip(dryTailChipWords(run), survey);
            chips.push({ lat: run.midLat, lon: run.midLon, text, tone: 'red' });
            placed.push(`${(run.lengthM / 1852).toFixed(2)}NM dry tail→red"${text}"`);
            continue;
        }
        const depth = run.minDepthM as number;
        const riseM = needM - depth;
        if (!(riseM > 0)) {
            // The keel clears it at every tide: only the survey words.
            if (survey.length > 0)
                chips.push({ lat: run.midLat, lon: run.midLon, text: survey.join(' · '), tone: 'amber' });
            continue;
        }
        const mid: [number, number] = [run.midLon, run.midLat];
        const minAt: [number, number] =
            typeof run.minAtLon === 'number' && typeof run.minAtLat === 'number' ? [run.minAtLon, run.minAtLat] : mid;
        const out: RouteChip[] = [];
        const red = (text: string, at: readonly [number, number]): void => {
            out.push({ lon: at[0], lat: at[1], text, tone: 'red' });
        };
        /** Its shallowest spot: why no tide clears it there, or null if one does. */
        const spotWords = (): string | null => {
            const t = tideAt(minAt[0], minAt[1]);
            if (!t) return notLoaded(riseM);
            return riseM > t.highestM + 1e-9
                ? shallowEndWords(depth, run.deepestM, riseM, t.highestM, curveSpanDays(t.curve, fromMs))
                : null;
        };
        const lift = liftable ? inRunOf(run, liftable) : null;
        if (lift && lift.length === 0) {
            // No tide could draw any of it amber: say why — with or without
            // a curve (round-4 review, 2026-09-30: offline, 6.4 km over
            // decision-1 water said only "no tide data — needs +0.6 m").
            red(redReasonWords(run, inCanal(run)), mid);
        } else if (curves.count === 0) {
            red(`no tide data — needs +${fmtM(riseM)}`, mid);
        } else if (!input.pieces) {
            // No drawn line to match: the run's shallowest spot decides.
            const words = spotWords();
            if (words !== null) red(words, minAt);
            else {
                const t = tideAt(minAt[0], minAt[1]) as Tide;
                out.push({ lon: mid[0], lat: mid[1], text: windowWords(depth, t), tone: 'amber' });
            }
        } else {
            // The drawn line decides: every chip names the colour under it.
            const amberHere = inRunOf(run, tidePieces);
            const redHere = inRunOf(run, redPieces);
            if (amberHere.length > 0) {
                // Its red first — the shallowest spot no tide clears, or why
                // the rest of it is red (a run a tide clears in part: round-4
                // review, 2026-09-30, the red stretch said nothing) — then
                // its amber, one chip.
                const words = redHere.length > 0 ? spotWords() : null;
                if (words !== null) red(words, minAt);
                else if (
                    redHere.length > 0 &&
                    (run.chartsDisagree || run.nearHazard || run.partUncharted || inCanal(run))
                )
                    red(redReasonWords(run, inCanal(run)), midpointOf(longestOf(redHere).coordinates));
                out.push(amberChip(amberHere));
                for (const p of amberHere) chipped.add(p);
            } else {
                // All red here, though some tide could lift some of it: where
                // no tide the app knows clears it, or none is loaded there —
                // said at its shallowest such stretch.
                const liftHere = lift ?? [];
                if (liftHere.length > 0) {
                    const low = liftHere.reduce((a, b) => ((b.depthM as number) < (a.depthM as number) ? b : a));
                    const need = needM - (low.depthM as number);
                    const top = topAlong(low.coordinates);
                    // The run's deepest is its shallowest spot's: read only
                    // where this stretch is that depth.
                    const deepest = low.depthM === depth ? run.deepestM : undefined;
                    red(
                        top === null
                            ? notLoaded(need)
                            : shallowEndWords(low.depthM as number, deepest, need, top.top, top.days),
                        midpointOf(low.coordinates),
                    );
                } else {
                    const words = spotWords();
                    if (words !== null) red(words, minAt);
                    else red(redReasonWords(run, inCanal(run)), mid);
                }
            }
        }
        if (out.length === 0) continue;
        // Depth from an acknowledged NtM survey, not the chart edition — say
        // so: the skipper needs to know WHICH authority the number is.
        if (run.ntmSurveyed) out[0].text += ' (NtM survey)';
        out[0].text = joinChip(out[0].text, survey);
        for (const c of out) {
            chips.push(c);
            placed.push(`${(run.lengthM / 1852).toFixed(2)}NM@${depth.toFixed(1)}m→${c.tone}"${c.text}"`);
        }
    }
    // Every amber stretch has its chip (round-4 review, 2026-09-30: one under
    // a chip run's 200 m — a 59 m stretch beside a rock — drew amber with no
    // chip, though the Chart key says "the chip says when"). Stretches within
    // 500 m of each other share one.
    const rest = tidePieces.filter((p) => !chipped.has(p)).sort((a, b) => a.u0 - b.u0);
    const groups: TidePiece[][] = [];
    for (const p of rest) {
        const g = groups[groups.length - 1];
        const last = g?.[g.length - 1].coordinates;
        const gapM = last
            ? haversineM(last[last.length - 1][1], last[last.length - 1][0], p.coordinates[0][1], p.coordinates[0][0])
            : Infinity;
        if (g && gapM <= AMBER_CHIP_MERGE_M) g.push(p);
        else groups.push([p]);
    }
    for (const g of groups) {
        const c = amberChip(g);
        chips.push(c);
        placed.push(`${(g.reduce((m, p) => m + coordsM(p.coordinates), 0) / 1852).toFixed(2)}NM→amber"${c.text}"`);
    }
    return { chips, placed };
}

export async function annotateTideWindows(opts: TideChipOptions): Promise<void> {
    const { map, runs, draftM, departureMs, isStale, markers } = opts;
    const place = (chip: RouteChip): void => {
        const marker = new mapboxgl.Marker({
            element: chipElement(chip.text, chip.tone),
            anchor: 'bottom',
            offset: [0, -8],
        })
            .setLngLat([chip.lon, chip.lat])
            .addTo(map);
        markers.push(marker);
    };
    try {
        const plan = routeChipPlan(runs, opts.surveyRuns);
        // The land-paint tails and the survey stretches need no tide curve:
        // label them first. Decision-1 water is red whatever the tide.
        for (const { run, survey } of plan.landPaint) {
            if (isStale()) return;
            place({
                lat: run.midLat,
                lon: run.midLon,
                text: joinChip(coarserLandPaintLabel(run), survey),
                tone: 'red',
            });
        }
        for (const chip of plan.survey) {
            if (isStale()) return;
            place({ lat: chip.lat, lon: chip.lon, text: chip.labels.join(' · '), tone: 'amber' });
        }
        const tideSafetyM = typeof opts.needM === 'number' ? opts.needM - draftM : DEFAULT_TIDE_SAFETY_M;
        // One curve per 0.25° bucket the shallow water lies in (round-4
        // review, 2026-09-30) — each stretch is coloured by its own place's
        // top, never another's — over the 14 days the rest of the app loads.
        // A run no tide could lift needs none.
        const liftable = opts.liftable;
        const tideRuns = plan.windowed
            .map((w) => w.run)
            .filter(
                (r) =>
                    !liftable ||
                    liftable.some(
                        (p) => p.u1 > r.startSeg + (r.startT ?? 0) + 1e-9 && p.u0 < r.endSeg + (r.endT ?? 1) - 1e-9,
                    ),
            );
        const fetches = tideFetchPlan(tideRuns, liftable ?? []);
        const byBucket = new Map<string, TideCurve>();
        if (fetches.length > 0) {
            const untilMs = departureMs + HORIZON_MS;
            const got = await Promise.all(
                fetches.map((f) =>
                    withTimeout(
                        fetchTideCurve(f.lat, f.lon, departureMs, untilMs, { days: TIDE_CURVE_MAX_DAYS }),
                        null,
                        CURVE_FETCH_TIMEOUT_MS,
                    ),
                ),
            );
            if (isStale()) return;
            fetches.forEach((f, k) => {
                const c = got[k];
                if (c) byBucket.set(f.bucket, c);
            });
            if (byBucket.size === 0)
                log.warn(
                    `[tideWindow] no tide curve (offline / non-LAT / timeout) — ${tideRuns.length} run(s) stay red, "no tide data"`,
                );
        }
        const curves = routeTideCurves(byBucket);
        // Redraw the line in what the tide can clear (decision 10) — before
        // the chips, which are worked from the line as drawn, so a chip never
        // names a colour the line does not show.
        // From the later of now and the departure on (fix-up, 2026-10-01):
        // the router's ceilings read the same.
        const nowMs = opts.nowMs ?? Date.now();
        const fromMs = Math.max(nowMs, departureMs);
        const tops = new Map<string, number | null>();
        for (const [k, c] of byBucket) tops.set(k, curveHighestM(c, fromMs));
        const drawn =
            byBucket.size > 0 ? opts.onTide?.((lon, lat) => tops.get(tideCurveBucket(lat, lon)) ?? null) : undefined;
        const { chips, placed } = tideRunChips({
            plan,
            curves,
            draftM,
            departureMs,
            nowMs,
            tideSafetyM,
            ...(drawn ? { pieces: drawn } : {}),
            ...(liftable ? { liftable } : {}),
            ...(opts.canalMask ? { canalMask: opts.canalMask } : {}),
        });
        for (const chip of chips) {
            if (isStale()) return;
            place(chip);
        }
        if (placed.length > 0)
            log.warn(
                `[tideWindow] ${placed.length} chip(s), ${byBucket.size} curve(s) [${[...byBucket]
                    .map(([k, c]) => `${k} ${c.stationName ?? 'station'} top ${tops.get(k)?.toFixed(2) ?? '∅'} m`)
                    .join('; ')}]: ${placed.join(' | ')}`,
            );
    } catch (err) {
        // Annotation must never break the rendered route.
        log.warn(`[tideWindow] failed (route unaffected): ${err instanceof Error ? err.message : String(err)}`);
    }
}
