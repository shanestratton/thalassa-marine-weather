/**
 * Plan Your Day's leave window (127-PYD-11): on a routed stop, when to leave
 * to carry the tide over the shallow bits of the routed line, there and back.
 * "Leave 06:40–09:10 to carry the tide over the shallow bit 4.2 NM out, there
 * and back; your 07:00 works."
 *
 * Shane, 2026-10-10: "we work within the rules, but we need to make it bang
 * claude. better than what we were going to do." It turns the route row's
 * amber "needs tide" into a time, from engines the app already has: the
 * router's own shallow runs (on the proposal, in memory) become the sweep's
 * spots (inshoreTideSpots), each with its tide place (the tide cache's 0.25°
 * bucket); every hourly departure of her day is swept every 10 minutes
 * (DepartureSweepInshore) at the speed her polar walk gave that leg, and each
 * shallow bit's time there is judged by the window maths (computeTidalWindows:
 * draft + 0.5 m, edges pulled in 30 min) around that time, so the pad holds
 * on a bar a few minutes out of the marina too; a step is clear only when
 * every bit is clear both ways. No curve is "Tide not known", never a guess;
 * red the tide cannot lift (a pin that dries, water no chart vouches for) is
 * always said.
 *
 * Tide changes when, never whether: nothing here moves the level, the best
 * leave or the ranking. Pure and in memory only: derived from charted depths
 * (o-charts, C10) and WorldTides heights (shown to her only, "check the
 * official tide table"), it is never stored and never logged.
 */
import type { TideCurve } from '../TideHeightService';
import { tideCurveBucket } from '../TideHeightService';
import type { ThalassaRouteDisclosure } from '../../types/autorouting';
import { dangerWithoutChartedDepth } from '../../components/map/inshoreRouteState';
import { sweepDepartures, type DepartureStatus, type ShallowSpot } from '../routing/DepartureSweepInshore';
import { motoringSpeedModel, tideFieldFromCurve } from '../routing/env/EnvFields';
import { shallowRunsToDepartureSpots } from '../routing/inshoreTideSpots';
import { computeTidalWindows, DEFAULT_TIDE_SAFETY_M, EDGE_PAD_MS } from '../routing/tidalWindow';
import { ROUTE_TIDE_CURVES_MAX } from '../tides/curveHighest';
import { calculateDistance } from '../../utils/navigationCalculations';
import { hhmm } from './today';

type LonLat = [number, number];

/** Each hourly departure is swept from 30 min before it to 20 min after, every 10 min. */
const STEP_MS = 600_000;
/** A shallow bit this close to an end is named by it: "leaving …", "at …". */
const END_NM = 0.5;

/** One gated shallow bit: the sweep's spot, its tide place, and for the words where it is and the rise it needs. */
export interface LeaveRun extends ShallowSpot {
    at: 'start' | 'stop' | 'out';
    nm: number;
    needM: number;
    group: number;
}

export interface LeaveSpots {
    /** The routed line, no leg over 0.1 NM: what the sweep walks. */
    line: LonLat[];
    lineNm: number;
    /** One per tide place (0.25° bucket), in order along the line; its curve is fetched at (lat, lon). */
    groups: { bucket: string; lat: number; lon: number }[];
    /** In order along the line. */
    runs: LeaveRun[];
    /** Red on the route that no tide clears. */
    red: boolean;
    /** The router reported any shallow run at all. */
    anyRuns: boolean;
    draftM: number;
}

/** NM along the line to each vertex. */
const alongNm = (coords: readonly LonLat[]) => {
    const nm = [0];
    for (let i = 1; i < coords.length; i++)
        nm.push(nm[i - 1] + calculateDistance(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));
    return nm;
};

/**
 * The routed line's tide gates, from the disclosure's own fields: the runs
 * with a charted depth the tide must lift (a needs-tide pin tail included;
 * a pin's dry tail never), each turned into the sweep's spot by
 * shallowRunsToDepartureSpots on the line filled out to legs of 0.1 NM (the
 * sweep times a bit at the end of its leg, and a routed line's long legs
 * would time it miles from where it is), with its tide place. Null for a
 * route whose masks did not verify: a window over an unverified line would
 * be false confidence.
 */
export function leaveSpots(
    coords: readonly LonLat[],
    engine: ThalassaRouteDisclosure | undefined,
    draftM: number,
): LeaveSpots | null {
    const line: LonLat[] = coords.slice(0, 1);
    for (let i = 1; i < coords.length; i++) {
        const [aLon, aLat] = coords[i - 1];
        const [bLon, bLat] = coords[i];
        // The short way round, across the antimeridian too.
        const dLon = ((bLon - aLon + 540) % 360) - 180;
        const n = Math.ceil(calculateDistance(aLat, aLon, bLat, bLon) / 0.1);
        for (let k = 1; k <= n; k++)
            line.push([((aLon + (dLon * k) / n + 540) % 360) - 180, aLat + ((bLat - aLat) * k) / n]);
    }
    if (!engine || engine.stateMask === null || line.length < 2) return null;
    const runs = engine.shallowRuns ?? [];
    const along = alongNm(line);
    const lineNm = along[along.length - 1];
    const groups: LeaveSpots['groups'] = [];
    const gated = runs
        .flatMap((raw) => {
            const lat = raw.minAtLat ?? raw.midLat;
            const lon = raw.minAtLon ?? raw.midLon;
            // Its shallowest point (else its middle) finds its leg on the filled line: the router's segment numbers do not.
            const [spot] = shallowRunsToDepartureSpots(line, [{ ...raw, minAtLat: lat, minAtLon: lon }]);
            const needM = draftM + DEFAULT_TIDE_SAFETY_M - (raw.minDepthM ?? NaN);
            if (!(needM > 0) || !spot) return [];
            // Along the line to the bit: to the end of its spot's leg, where the sweep times it.
            const nm = along[spot.legIndex + 1];
            const at: LeaveRun['at'] =
                raw.endpointTail === 'origin' || nm <= END_NM
                    ? 'start'
                    : raw.endpointTail === 'destination' || lineNm - nm <= END_NM
                      ? 'stop'
                      : 'out';
            return [{ ...spot, at, nm, needM, group: 0, lat, lon }];
        })
        .sort((x, y) => x.nm - y.nm);
    for (const g of gated) {
        const bucket = tideCurveBucket(g.lat, g.lon);
        g.group = groups.findIndex((x) => x.bucket === bucket);
        if (g.group < 0) g.group = groups.push({ bucket, lat: g.lat, lon: g.lon }) - 1;
    }
    return {
        line,
        lineNm,
        groups,
        runs: gated,
        red:
            runs.some(
                (r) =>
                    r.dryTail || !Number.isFinite(r.minDepthM) || r.partUncharted || r.nearHazard || r.chartsDisagree,
            ) || (dangerWithoutChartedDepth(engine)?.length ?? 0) > 0,
        anyRuns: runs.length > 0,
        draftM,
    };
}

/**
 * Each tide place's curve, one call per place and at most the router's own
 * ROUTE_TIDE_CURVES_MAX; a place past the cap, or whose curve fails, is null
 * ("tide not known there"), never a throw.
 */
export function leaveCurves(
    spots: LeaveSpots,
    load: (lat: number, lon: number, fromMs: number, toMs: number) => Promise<TideCurve | null>,
    fromMs: number,
    toMs: number,
): Promise<(TideCurve | null)[]> {
    return Promise.all(
        spots.groups.map((g, i) =>
            i < ROUTE_TIDE_CURVES_MAX ? load(g.lat, g.lon, fromMs, toMs).catch(() => null) : null,
        ),
    );
}

/** The parts of a DepartureEval the window reads. */
export interface LeaveDeparture {
    departureMs: number;
    stayEndMs: number | null;
    out: { durationMs: number | null };
    home: { durationMs: number | null } | null;
}

export interface LeaveResult {
    /** no-times: no departures to judge (no forecast along the way): what the tide must give, never a time. */
    kind: 'window' | 'none' | 'unknown' | 'not-gated' | 'no-times';
    /** Every clear stretch, in time order: departure times, on the leave she would choose. */
    windows: { fromMs: number; toMs: number }[];
    approx: boolean;
    red: boolean;
    dayTrip: boolean;
    /** The runs the words name. */
    runs: LeaveRun[];
    stations: string[];
    /** A tide curve was read: WorldTides is credited. */
    read: boolean;
    anyRuns: boolean;
}

const worse = (a: DepartureStatus, b: DepartureStatus): DepartureStatus =>
    a === 'blocked' || b === 'blocked' ? 'blocked' : a === 'unknown' || b === 'unknown' ? 'unknown' : 'clear';

/**
 * When she can leave today: every hourly departure swept from 30 min before
 * it (never before the day's earliest leave) to 20 min after, every 10 min,
 * out at the speed her polar walk gave the way there (cruising speed when it
 * had none) and, for a day trip, home on the reversed line after her stay.
 * Each bit's time there is judged on the tide from an hour before it to an
 * hour after, so a crossing just before she reaches it is a true crossing,
 * padded, never the edge of the search. A time outside its curve is not
 * known, never blocked: an answer the tide data cannot give is not a "no".
 */
export function leaveWindow(a: {
    spots: LeaveSpots;
    curves: readonly (TideCurve | null)[];
    departures: readonly LeaveDeparture[];
    earliestMs: number | null;
    dayTrip: boolean;
    cruiseKts: number;
}): LeaveResult {
    const { spots, curves, dayTrip } = a;
    const { line, runs } = spots;
    const used = curves.filter((c): c is TideCurve => !!c);
    const base = {
        windows: [],
        approx: used.some((c) => c.provenance === 'EXTREMES_INTERP'),
        red: spots.red,
        dayTrip,
        runs,
        stations: [...new Set(used.flatMap((c) => (c.stationName ? [c.stationName] : [])))],
        read: used.length > 0,
        anyRuns: spots.anyRuns,
    };
    if (!runs.length) return { ...base, kind: 'not-gated' };
    const last = line.length - 2;
    const home = runs.map((r) => ({ ...r, legIndex: last - r.legIndex }));
    const fields = spots.groups.map((_, i) => (curves[i] ? tideFieldFromCurve(curves[i]!) : null));
    // Undefined: not known (no stay end, a sweep that walked nothing); null: a leg the line lacks, never clear.
    const judge = (r: LeaveRun, eta: number | null | undefined): DepartureStatus => {
        const tide = fields[r.group];
        const cover = tide?.coverage();
        if (eta === null) return 'blocked';
        if (eta === undefined || !tide || !cover || eta < cover[0] || eta > cover[1]) return 'unknown';
        return computeTidalWindows({
            minDepthM: r.minDepthM,
            draftM: spots.draftM,
            tide,
            fromMs: eta - 2 * EDGE_PAD_MS,
            untilMs: eta + 2 * EDGE_PAD_MS,
        }).windows.some((w) => w.openMs <= eta && eta <= w.closeMs)
            ? 'clear'
            : 'blocked';
    };
    // Her times at every bit, from one walk per step (the sweep with no tide: its ETAs only).
    const etas = (
        polyline: LonLat[],
        shallowSpots: ShallowSpot[],
        startMs: number,
        count: number,
        ms?: number | null,
    ) =>
        sweepDepartures({
            polyline,
            speed:
                ms && ms > 0 && spots.lineNm > 0
                    ? { stwMs: () => (spots.lineNm * 1852) / (ms / 1000) }
                    : motoringSpeedModel(a.cruiseKts),
            tide: null,
            shallowSpots,
            draftM: spots.draftM,
            startMs,
            count,
            stepMs: STEP_MS,
        }).options;
    const steps: { t: number; s: DepartureStatus }[] = [];
    for (const d of a.departures) {
        const from = Math.max(d.departureMs - 3 * STEP_MS, a.earliestMs ?? -Infinity);
        const count = Math.floor((d.departureMs + 2 * STEP_MS - from) / STEP_MS) + 1;
        if (!(count > 0)) continue;
        const go = etas(line, runs, from, count, d.out.durationMs);
        const back =
            dayTrip && d.stayEndMs !== null
                ? etas([...line].reverse(), home, from + d.stayEndMs - d.departureMs, count, d.home?.durationMs)
                : [];
        for (let j = 0; j < count; j++)
            steps.push({
                t: from + j * STEP_MS,
                s: runs.reduce<DepartureStatus>(
                    (s, r, k) =>
                        worse(
                            worse(s, judge(r, go[j]?.windows[k].etaMs)),
                            dayTrip ? judge(r, back[j]?.windows[k].etaMs) : 'clear',
                        ),
                    'clear',
                ),
            });
    }
    if (!steps.length) return { ...base, kind: 'no-times', read: false };
    steps.sort((x, y) => x.t - y.t);
    const windows: LeaveResult['windows'] = [];
    let open: { fromMs: number; toMs: number } | null = null;
    for (const { t, s } of steps) {
        // A gap in her departures ends a stretch: no time in it was checked.
        if (s !== 'clear' || (open && t - open.toMs > STEP_MS)) open = null;
        if (s !== 'clear') continue;
        if (open) open.toMs = t;
        else windows.push((open = { fromMs: t, toMs: t }));
    }
    if (windows.length) return { ...base, kind: 'window', windows };
    if (!steps.some((x) => x.s === 'unknown')) return { ...base, kind: 'none' };
    const unknown = runs.filter((r) => !fields[r.group]);
    return { ...base, kind: 'unknown', runs: unknown.length ? unknown : runs };
}

/** Her leave against the windows: inside one works; else too late for the nearer before it, or too early. */
export function leaveChosen(
    windows: readonly { fromMs: number; toMs: number }[],
    chosenMs: number | null,
): 'works' | 'too-early' | 'too-late' | null {
    if (chosenMs === null || !windows.length) return null;
    if (windows.some((w) => w.fromMs <= chosenMs && chosenMs <= w.toMs)) return 'works';
    const before = windows.filter((w) => w.toMs < chosenMs).pop();
    const after = windows.find((w) => w.fromMs > chosenMs);
    if (!after) return 'too-late';
    if (!before) return 'too-early';
    return chosenMs - before.toMs < after.fromMs - chosenMs ? 'too-late' : 'too-early';
}

/**
 * The row, in her words, on the place's clock: the window and whether her
 * leave works (at most two windows said: the one she leaves in, or the
 * nearest to it, and the next nearest), nothing clears, the tide not known
 * or no forecast to time it by (each with the rise it needs, never a time),
 * or nothing to wait for; then (`more`, the sentences a tight page folds
 * under the first) the red the tide cannot clear, and for an overnight the
 * morning's tide. The footnote credits WorldTides (and its station) whenever
 * a curve was read.
 */
export function leaveWords(
    r: LeaveResult,
    chosenMs: number | null,
    names: { zone: string; start: string; stop: string; day: string },
): { text: string; more: string | null; footnote: string | null } {
    const t = (ms: number) => hhmm(ms, names.zone);
    const place = (x: LeaveRun) =>
        x.at === 'start'
            ? `leaving ${names.start}`
            : x.at === 'stop'
              ? `at ${names.stop}`
              : `${x.nm.toFixed(1)} NM out`;
    const [x, y] = r.runs;
    const what =
        r.runs.length === 1
            ? `the shallow bit ${place(x)}`
            : r.runs.length === 2
              ? `the shallow bits ${x.at === 'out' && y.at === 'out' ? `${x.nm.toFixed(1)} and ${y.nm.toFixed(1)} NM out` : `${place(x)} and ${place(y)}`}`
              : `${r.runs.length} shallow bits`;
    const both = r.dayTrip ? ', there and back' : '';
    const chosen = leaveChosen(r.windows, chosenMs);
    const gap = (w: { fromMs: number; toMs: number }) =>
        chosenMs === null ? w.fromMs : Math.max(w.fromMs - chosenMs, chosenMs - w.toMs);
    const said = [...r.windows]
        .sort((p, q) => gap(p) - gap(q))
        .slice(0, 2)
        .sort((p, q) => p.fromMs - q.fromMs);
    const need = Math.max(...r.runs.map((u) => u.needM)).toFixed(1);
    const first =
        r.kind === 'not-gated'
            ? `${r.anyRuns ? 'Nothing on the way waits for the tide' : 'No charted shallow water on the way'}: the tide doesn't limit when you leave.`
            : r.kind === 'window'
              ? `Leave ${said.map((w) => (w.fromMs === w.toMs ? t(w.fromMs) : `${t(w.fromMs)}–${t(w.toMs)}`)).join(' or ')}${r.approx ? ' (tide approx)' : ''} to carry the tide over ${what}${both}${chosen ? `; your ${t(chosenMs!)} ${chosen === 'works' ? 'works' : `is ${chosen.replace('-', ' ')} for it`}` : ''}.`
              : r.kind === 'none'
                ? `No leave time ${names.day} carries the tide over ${what}${both}: see it on the chart, or try another day.`
                : `${r.kind === 'unknown' ? 'Tide not known' : 'No leave time without a forecast'} for ${what} (${r.runs.length === 1 ? `it needs ${need} m of tide` : `up to ${need} m of tide needed`}): check the tide table before you go.`;
    const more = [
        r.red ? 'Red on the route that no tide clears: see it on the chart.' : '',
        !r.dayTrip && r.kind !== 'not-gated' ? 'Home tomorrow: check its tide in the morning.' : '',
    ]
        .filter(Boolean)
        .join(' ');
    return {
        text: more ? `${first} ${more}` : first,
        more: more || null,
        footnote: r.read
            ? `Tide from WorldTides${r.stations.length ? ` (${r.stations.join(', ')})` : ''}; check the official tide table.`
            : null,
    };
}
