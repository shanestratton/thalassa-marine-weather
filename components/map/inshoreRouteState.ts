/**
 * The per-segment colour of a freshly drawn inshore route (usePassagePlanner).
 * Pure, so the precedence is testable.
 *
 * Shane's INNER→OUTER scheme. Precedence:
 *   1. caution over CHARTED-SHALLOW water → RED ('danger'), even in a marked
 *      channel (fix-up, 2026-09-30). Marks say where the channel is, not how
 *      deep it is (owner decision 6: charted-but-shallow leads are amber 'needs
 *      tide'; Phase 2a: leads never override depth). Round 2 removed the grid's
 *      5 m lead and fairway rescues so this water would read 'needs tide', but
 *      the old "marks ARE the depth authority" rule below still painted it
 *      yellow: on the production-shape goldens ~3 km of the Newport routes'
 *      yellow track is shallower than draft + UKC and 71 m of it dries, with
 *      no tide chip.
 *      Decision-1 water beats it too (round-3 review, 2026-09-30): caution
 *      over a finer never-drying band under a coarser chart's land paint
 *      (landPaintConflictMask) — shallow water, never deep (owner decision 1)
 *      — drew yellow mid-route, like a deep buoyed channel; it is red, as its
 *      endpoint tails are, with the 'charts disagree' chip.
 *   2. tier-2 marked channel → YELLOW ('channel') — and this beats the OTHER
 *      caution: a buoyed channel over uncharted water reads yellow, not red,
 *      as it did (d-1, the "red not yellow" bug). The cautionMask is still
 *      computed for the safety scorecard.
 *   3. canal centre-line → RED ('danger') — the marina basin.
 *   4. caution (shallow/uncharted OPEN water, NOT a marked channel) → RED.
 *   5. offshore → DARK BLUE; else inshore A* → TEAL ('green' default).
 *
 * "Charted-shallow" is the router's per-segment chartedShallowMask; a result
 * without it (a cloud or older route) falls back to its shallowRuns that
 * carry a charted depth. Missing or mismatched masks are not an "all normal"
 * verdict: null, and the whole line is drawn unverified.
 *
 * Over all of it (inshoreRoutePieces), the BACKSTOP (round-3 review,
 * 2026-09-30): wherever the finest S-57 survey charts water shallower than
 * draft + UKC on a segment the grid did NOT flag caution
 * (chartedShallowSpans — cut at the depth bands' own edges), that stretch is
 * RED whatever the segment's colour. OSM water outranking the chart's own
 * band in the grid drew ~2.9 km of the Brisbane River mouth's drying bank as
 * a yellow marked channel with no chip; the grid no longer lets it, and this
 * is the second line of defence. Survey dashes (decision 9) never cover it.
 *
 * THE TIDE (owner decision 10, Shane 2026-09-30: "Amber if a tide clears
 * it"). A stretch red for its charted depth alone — caution over
 * charted-shallow water (RouteResult.tideDepthM), or a backstop stretch — is
 * drawn AMBER ('tide') when some state of tide gives draft + UKC over it, and
 * stays RED only where no tide ever will: it dries 2 m, or needs more tide
 * than the place has. "Ever" is the highest tide the app knows there
 * (tideWindowChips curveHighestM); with no tide data nothing is proven, so it
 * stays red with a 'no tide data' chip. Drying water follows the same sum.
 * The canal's red, uncharted or unvouched water, a charted hazard's buffer
 * and decision-1 water keep their red whatever the tide — a backstop
 * stretch too, which the tide lifts only when the router says its depth
 * alone is its red (ChartedShallowSpan.tideLiftable; round-4 review,
 * 2026-09-30). The highest tide is the one fetched for THAT place
 * (RouteTide.highestAt, the tide cache's 0.25° buckets), never another
 * stretch's 25 km away. Decision 9's survey stretches are amber DOTS
 * (SURVEY_DASH), so the two never look alike. It answers the round-3
 * review's open question: red was needs-tide and amber was survey, both
 * solid #ff9100 where drawn.
 */
import {
    AMBER_SURVEY_REASONS,
    type ChartedShallowSpan,
    type ShallowRunInfo,
    type SurveyRunInfo,
} from '../../services/engine/types';

/** ONE amber for 'needs tide' (owner decision 10, 2026-09-30): the route
 *  line, its tide chip and the lead overlay (useChartLeadsLayer AMBER_INK).
 *  The route layers' old 'caution' orange — never the channel's yellow
 *  (#facc15), which the overlay's #fbbf24 all but matched on a route line. */
export const NEEDS_TIDE_AMBER = '#ff9100';

/** Decision 9's survey stretches: the needs-tide amber in round DOTS on a
 *  dark casing, so a survey stretch never reads as the solid amber of a
 *  needs-tide one. Round-4 review (2026-09-30): they were the lead overlay's
 *  own needs-tide dash (#ff9100 [1.6, 1.2] on #1c1917, useChartLeadsLayer),
 *  and a route usually rides the leads — "survey" on the route and "needs
 *  tide" on the lead under it looked the same. */
export const SURVEY_DASH = {
    ink: NEEDS_TIDE_AMBER,
    casing: '#1c1917',
    dasharray: [0.1, 2],
    cap: 'round',
} as const;

export type InshoreSegmentState = 'danger' | 'channel' | 'offshore' | 'green';

export interface InshoreRouteMasks {
    polyline: readonly (readonly [number, number])[];
    cautionMask?: readonly boolean[];
    canalMask?: readonly boolean[];
    channelMask?: readonly boolean[];
    tier4Mask?: readonly boolean[];
    offshoreMask?: readonly boolean[];
    chartedShallowMask?: readonly boolean[];
    landPaintConflictMask?: readonly boolean[];
    shallowRuns?: readonly ShallowRunInfo[];
    tideDepthM?: readonly (number | null)[];
    chartedShallowSpans?: readonly ChartedShallowSpan[];
}

export function inshoreSegmentStates(r: InshoreRouteMasks): InshoreSegmentState[] | null {
    const segCount = r.polyline.length - 1;
    const hasMask = (m?: readonly boolean[]): m is readonly boolean[] => !!m && m.length === segCount;
    const channelMask = hasMask(r.channelMask) ? r.channelMask : r.tier4Mask;
    const cautionMask = r.cautionMask;
    const canalMask = r.canalMask;
    const offshoreMask = r.offshoreMask;
    // Every colour mask is part of the renderer's safety contract.
    const inshoreMasksVerified =
        hasMask(cautionMask) && hasMask(canalMask) && hasMask(channelMask) && hasMask(offshoreMask);
    if (r.polyline.length < 2 || !inshoreMasksVerified) return null;
    const chartedShallow: readonly boolean[] = hasMask(r.chartedShallowMask)
        ? r.chartedShallowMask
        : Array.from({ length: segCount }, (_, i) =>
              (r.shallowRuns ?? []).some((run) => run.minDepthM !== null && run.startSeg <= i && i <= run.endSeg),
          );
    const conflict = hasMask(r.landPaintConflictMask) ? r.landPaintConflictMask : null;
    return Array.from({ length: segCount }, (_, i): InshoreSegmentState => {
        if (cautionMask[i] && chartedShallow[i]) return 'danger'; // charted-shallow RED (beats yellow)
        if (cautionMask[i] && conflict?.[i]) return 'danger'; // decision-1 water RED (beats yellow)
        if (channelMask[i]) return 'channel'; // marked channel YELLOW (beats other caution)
        if (canalMask[i]) return 'danger'; // canal/marina RED
        if (cautionMask[i]) return 'danger'; // shallow/uncharted OPEN water RED
        return offshoreMask[i] ? 'offshore' : 'green';
    });
}

/**
 * Per segment, the charted depth a tide must lift for the planner to draw
 * that segment amber instead of red (owner decision 10, 2026-09-30) — the
 * engine's RouteResult.tideDepthM on a segment red for its depth alone, else
 * null. The canal's red and decision-1 water are not the tide's to lift (the
 * engine already leaves out a hazard's buffer and uncharted samples). Null
 * for masks that do not verify; all null without the engine's mask (an older
 * or cloud route: red, as before).
 */
export function routeTideDepths(r: InshoreRouteMasks): (number | null)[] | null {
    const segCount = r.polyline.length - 1;
    if (segCount < 1) return null;
    const fits = <T>(m?: readonly T[]): m is readonly T[] => !!m && m.length === segCount;
    const depth = fits(r.tideDepthM) ? r.tideDepthM : null;
    return Array.from({ length: segCount }, (_, i) => {
        const d = depth?.[i];
        if (typeof d !== 'number' || !Number.isFinite(d)) return null;
        if (!r.cautionMask?.[i] || r.canalMask?.[i] || r.landPaintConflictMask?.[i]) return null;
        return d;
    });
}

/**
 * Does some state of tide give draft + UKC over this charted depth (owner
 * decision 10)? `highestM` is the highest tide the app knows there, m above
 * LAT; null — no tide data — proves nothing: false. A drying depth is
 * negative and takes the same sum (dries 2 m, needs 2.9 m: +4.9 m of tide).
 */
export function tideClears(depthM: number, needM: number, highestM: number | null): boolean {
    if (highestM === null || !Number.isFinite(highestM) || !Number.isFinite(depthM)) return false;
    return needM - depthM <= highestM + 1e-9;
}

/** What the planner knows about the tide when it draws the route (decision 10). */
export interface RouteTide {
    /** Per segment (routeTideDepths): the depth a tide must lift, or null. */
    depthM: readonly (number | null)[] | null;
    /** Draft + UKC, metres. */
    needM: number;
    /** The highest tide the app knows for the place, m above LAT; null = no tide data. */
    highestM: number | null;
    /**
     * The highest tide the app knows AT a spot, m above LAT, or null where no
     * tide curve was loaded for it (round-4 review, 2026-09-30: one curve's
     * top coloured every stretch of the route, however far from where it was
     * fetched). When given it decides, not highestM: a stretch takes the
     * lowest top along it (tideTopAlong).
     */
    highestAt?: (lon: number, lat: number) => number | null;
}

/** Spots along a stretch at which the tide's top is read (tideTopAlong): at
 *  most this far apart, ends included — well inside a 0.25° tide bucket. */
const TIDE_TOP_STEP_M = 1000;

/** The spots along a stretch the tide's top is read at (pure; round-4
 *  review, 2026-09-30): every vertex, and every ≤1 km between. The chips
 *  fetch a curve for each bucket these fall in (tideWindowChips
 *  tideFetchPlan), so the line never asks about a place nobody fetched. */
export function tideTopSpots(coords: readonly (readonly [number, number])[]): [number, number][] {
    if (coords.length === 0) return [];
    const out: [number, number][] = [[coords[0][0], coords[0][1]]];
    for (let i = 1; i < coords.length; i++) {
        const [lonA, latA] = coords[i - 1];
        const [lonB, latB] = coords[i];
        const n = Math.max(1, Math.ceil(pieceM([coords[i - 1], coords[i]]) / TIDE_TOP_STEP_M));
        for (let k = 1; k <= n; k++) out.push([lonA + ((lonB - lonA) * k) / n, latA + ((latB - latA) * k) / n]);
    }
    return out;
}

/**
 * The highest tide the app knows along a drawn stretch (pure; round-4
 * review, 2026-09-30): the LOWEST of the tops read along it (tideTopSpots),
 * so a stretch that runs into a place with a smaller range is judged by it;
 * null when any of it has no tide loaded, or with no tide at all.
 */
export function tideTopAlong(
    tide: RouteTide | undefined,
    coords: readonly (readonly [number, number])[],
): number | null {
    if (!tide) return null;
    const at = tide.highestAt;
    if (!at) return tide.highestM;
    const spots = tideTopSpots(coords);
    if (spots.length === 0) return null;
    let top = Infinity;
    for (const [lon, lat] of spots) {
        const h = at(lon, lat);
        if (h === null || !Number.isFinite(h)) return null;
        if (h < top) top = h;
    }
    return top;
}

/**
 * A drawn piece of the route: 'survey' is decision 9's disclosure (owner
 * decision 9, 2026-09-30: "Yes, amber on the route") — old, ungraded or
 * too-rough survey under water the route otherwise draws teal, yellow or
 * blue — drawn as amber DASHES since decision 10 (SURVEY_DASH). 'tide' is
 * decision 10's amber: shallow water some tide clears, drawn solid in
 * NEEDS_TIDE_AMBER with its tide-window chip.
 */
export type InshoreRenderState = InshoreSegmentState | 'survey' | 'tide';

export interface InshoreRoutePiece {
    state: InshoreRenderState;
    coordinates: [number, number][];
    /** Where it runs along the route, as segment + fraction. */
    u0: number;
    u1: number;
    /** A 'tide' piece: the shallowest charted depth under it — the depth its
     *  tide window is worked from (tideWindowChips tideRunChips). */
    depthM?: number;
}

/**
 * The route cut into drawn pieces (pure): runs of one per-segment state
 * (inshoreSegmentStates), with the survey stretches (surveyRuns) laid over
 * them and cut at their EXACT ends — a stretch is sampled every 25 m along
 * the route, and a 3 km segment with 200 m of ungraded survey draws 200 m of
 * dashes, not 3 km. Survey dashes only replace teal, yellow and blue: a red
 * or needs-tide stretch keeps its colour — the more serious one — and its
 * chip carries the survey words too. 'survey-unchecked' is never drawn (a
 * caveat, like decision 8's bridges). The backstop's charted-shallow
 * stretches (chartedShallowSpans, round-3 review, 2026-09-30) are laid over
 * everything at their exact ends.
 *
 * `tide` (owner decision 10, 2026-09-30): a stretch red for its charted depth
 * alone — a segment with a routeTideDepths depth, or a backstop stretch over
 * teal, yellow or blue that the router marks tideLiftable — is 'tide'
 * (amber) where tideClears against the top of the tide along it
 * (tideTopAlong), else red. Without it (no tide data, a saved plan) every
 * such stretch is red.
 */
export function inshoreRoutePieces(
    polyline: readonly (readonly [number, number])[],
    stateMask: readonly InshoreSegmentState[],
    surveyRuns: readonly SurveyRunInfo[] = [],
    chartedShallowSpans: readonly ChartedShallowSpan[] = [],
    tide?: RouteTide,
): InshoreRoutePiece[] {
    const segCount = polyline.length - 1;
    if (segCount < 1 || stateMask.length !== segCount) return [];
    // Intervals in route parameter u = segment + fraction.
    const intervals = <T extends { startSeg: number; startT: number; endSeg: number; endT: number }>(
        xs: readonly T[],
    ) =>
        xs
            .map((r) => ({ a: r.startSeg + r.startT, b: r.endSeg + r.endT, r }))
            .filter(({ a, b }) => Number.isFinite(a) && Number.isFinite(b) && b > a)
            .sort((x, y) => x.a - y.a);
    const amber = intervals(surveyRuns.filter((r) => AMBER_SURVEY_REASONS.has(r.reason)));
    const red = intervals(Array.isArray(chartedShallowSpans) ? chartedShallowSpans : []);
    const inAmber = (u: number): boolean => amber.some(({ a, b }) => u > a && u < b);
    const redAt = (u: number): ChartedShallowSpan | null => red.find(({ a, b }) => u > a && u < b)?.r ?? null;
    const clears = (d: number | null | undefined, coords: readonly (readonly [number, number])[]): boolean =>
        !!tide && typeof d === 'number' && tideClears(d, tide.needM, tideTopAlong(tide, coords));
    const segDepth = (i: number): number | null =>
        tide?.depthM && tide.depthM.length === segCount ? tide.depthM[i] : null;
    const at = (i: number, t: number): [number, number] => {
        const [lonA, latA] = polyline[i];
        const [lonB, latB] = polyline[i + 1];
        return [lonA + (lonB - lonA) * t, latA + (latB - latA) * t];
    };
    const pieces: InshoreRoutePiece[] = [];
    let current: InshoreRoutePiece | null = null;
    const push = (
        state: InshoreRenderState,
        from: [number, number],
        to: [number, number],
        u0: number,
        u1: number,
        depthM: number | null,
    ): void => {
        if (current && current.state === state) {
            current.coordinates.push(to);
            current.u1 = u1;
            if (depthM !== null && !(current.depthM !== undefined && current.depthM <= depthM)) current.depthM = depthM;
            return;
        }
        current = { state, coordinates: [from, to], u0, u1, ...(depthM !== null ? { depthM } : {}) };
        pieces.push(current);
    };
    for (let i = 0; i < segCount; i++) {
        const base = stateMask[i];
        // Cut this segment at every survey and backstop edge inside it.
        const cuts = [0, 1];
        for (const { a, b } of [...amber, ...red]) {
            for (const u of [a, b]) if (u > i && u < i + 1) cuts.push(u - i);
        }
        cuts.sort((x, y) => x - y);
        const overridable = base === 'green' || base === 'channel' || base === 'offshore';
        for (let k = 0; k + 1 < cuts.length; k++) {
            const t0 = cuts[k];
            const t1 = cuts[k + 1];
            if (t1 - t0 <= 0) continue;
            const um = i + (t0 + t1) / 2;
            const span = redAt(um);
            const from: [number, number] = t0 === 0 ? [polyline[i][0], polyline[i][1]] : at(i, t0);
            const to: [number, number] = t1 === 1 ? [polyline[i + 1][0], polyline[i + 1][1]] : at(i, t1);
            // Most serious first: red (no tide clears it, or a red the tide
            // cannot lift), then needs-tide amber, then survey dots. A
            // backstop stretch is the tide's to lift only when the router says
            // its depth alone is its red (tideLiftable: not in a charted
            // hazard's buffer, not decision-1 water; round-4 review,
            // 2026-09-30) — absent, red whatever the tide.
            const state: InshoreRenderState = span
                ? overridable && span.tideLiftable === true && clears(span.minDepthM, [from, to])
                    ? 'tide'
                    : 'danger'
                : base === 'danger'
                  ? clears(segDepth(i), [from, to])
                      ? 'tide'
                      : 'danger'
                  : overridable && inAmber(um)
                    ? 'survey'
                    : base;
            push(state, from, to, i + t0, i + t1, state === 'tide' ? (span ? span.minDepthM : segDepth(i)) : null);
        }
    }
    return pieces;
}

/**
 * The stretches of the route SOME tide could draw amber (pure; round-4
 * review, 2026-09-30) — known before any tide curve arrives: the pieces
 * inshoreRoutePieces draws 'tide' under a tide with no top. A shallow run
 * with none of these in it is red whatever the tide (decision-1 water, a
 * hazard's buffer, water no chart covers, the canal), and its chip says so
 * with or without a curve, never 'no tide data'.
 */
export function tideLiftablePieces(
    polyline: readonly (readonly [number, number])[],
    stateMask: readonly InshoreSegmentState[],
    chartedShallowSpans: readonly ChartedShallowSpan[] = [],
    depthM: readonly (number | null)[] | null,
    needM: number,
): InshoreRoutePiece[] {
    return inshoreRoutePieces(polyline, stateMask, [], chartedShallowSpans, {
        depthM,
        needM,
        highestM: Number.MAX_VALUE,
    }).filter((p) => p.state === 'tide');
}

/**
 * The drawn pieces as the route-line source's features (pure). `safety` is
 * the piece's state: 'danger' red, 'tide' needs-tide amber, 'survey' amber
 * dashes (surveyDashLayers), 'channel' yellow, 'offshore' blue, 'green' teal.
 * Decision 9's stretches used to ride the route layers' solid 'caution'
 * colour — the colour a needs-tide stretch now draws (decision 10).
 */
export function inshoreRouteFeatures(pieces: readonly InshoreRoutePiece[]): {
    type: 'Feature';
    properties: { safety: InshoreRenderState; source: 'inshore-router'; verification: 'verified' };
    geometry: { type: 'LineString'; coordinates: [number, number][] };
}[] {
    return pieces.map((piece) => ({
        type: 'Feature',
        properties: { safety: piece.state, source: 'inshore-router', verification: 'verified' },
        geometry: { type: 'LineString', coordinates: piece.coordinates },
    }));
}

/** A Mapbox line layer, as plain data (this module stays free of mapbox-gl). */
export interface RouteLineLayerSpec {
    id: string;
    type: 'line';
    source: string;
    filter: unknown[];
    layout: { 'line-join': 'round' | 'bevel' | 'miter'; 'line-cap': 'butt' | 'round' | 'square' };
    paint: { 'line-color': string; 'line-width': number; 'line-opacity': number };
}

/**
 * Decision 9's survey stretches on the route line (owner decision 10,
 * 2026-09-30): the needs-tide amber in round dots on a dark casing (dashes
 * until the round-4 review — the lead overlay's own needs-tide dash) — so
 * they never look like the solid amber of a stretch that needs tide, nor a
 * lead that does. The route's solid layers leave 'survey' out.
 */
export function surveyDashLayers(
    source: string,
): [RouteLineLayerSpec, RouteLineLayerSpec & { paint: RouteLineLayerSpec['paint'] & { 'line-dasharray': number[] } }] {
    const filter = ['==', ['get', 'safety'], 'survey'];
    return [
        {
            id: 'route-survey-casing',
            type: 'line',
            source,
            filter,
            layout: { 'line-join': 'round', 'line-cap': 'butt' },
            paint: { 'line-color': SURVEY_DASH.casing, 'line-width': 6, 'line-opacity': 0.8 },
        },
        {
            id: 'route-survey-dash',
            type: 'line',
            source,
            filter,
            layout: { 'line-join': 'round', 'line-cap': SURVEY_DASH.cap },
            paint: {
                'line-color': SURVEY_DASH.ink,
                'line-width': 3,
                'line-opacity': 0.95,
                'line-dasharray': [...SURVEY_DASH.dasharray],
            },
        },
    ];
}

/** Metres along a drawn piece. */
function pieceM(coords: readonly (readonly [number, number])[]): number {
    let m = 0;
    for (let i = 1; i < coords.length; i++) {
        const [lonA, latA] = coords[i - 1];
        const [lonB, latB] = coords[i];
        const dLat = ((latB - latA) * Math.PI) / 180;
        const dLon = ((lonB - lonA) * Math.PI) / 180;
        const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos((latA * Math.PI) / 180) * Math.cos((latB * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
        m += 2 * 6_371_000 * Math.asin(Math.sqrt(a));
    }
    return m;
}

/**
 * How much of the route's survey stretches the planner actually draws as
 * survey dashes (pure; round-3 review, 2026-09-30; dashes since decision 10),
 * per caveat: 'margin' (the survey may be out by more than the keel margin)
 * and 'poor' (old or ungraded). The caveat said "(marked amber)" whatever was
 * drawn — on Newport → Tangalooma all 0.7 km of CATZOC D lies under the
 * canal's red — so the words follow these metres (inshoreRouteNotice
 * surveyCaveats). The tide never turns a stretch into dashes, so these are
 * the same with or without it.
 */
export function surveyAmberMetres(
    polyline: readonly (readonly [number, number])[],
    stateMask: readonly InshoreSegmentState[] | null,
    surveyRuns: readonly SurveyRunInfo[] = [],
    chartedShallowSpans: readonly ChartedShallowSpan[] = [],
): { marginM: number; poorM: number } {
    if (!stateMask || !Array.isArray(surveyRuns)) return { marginM: 0, poorM: 0 };
    const amberOf = (runs: readonly SurveyRunInfo[]): number =>
        runs.length === 0
            ? 0
            : inshoreRoutePieces(polyline, stateMask, runs, chartedShallowSpans)
                  .filter((p) => p.state === 'survey')
                  .reduce((m, p) => m + pieceM(p.coordinates), 0);
    return {
        marginM: amberOf(surveyRuns.filter((r) => r?.reason === 'survey-margin')),
        poorM: amberOf(surveyRuns.filter((r) => r?.reason === 'survey-poor' || r?.reason === 'survey-ungraded')),
    };
}
