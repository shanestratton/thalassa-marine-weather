/**
 * Plan Your Day routes the stop she opens (127-PYD-2), through Auto's own
 * provider and nothing else: calculateThalassaProposal, the strict engine in
 * the route worker (127-ROUTE-W), its refusals in its own words. Never the raw
 * engine, never the Pi's /api/enc/route, and never a line when there is no
 * route.
 *
 * Shane, 2026-10-10: "when you select somewhere, and plot on the chart. it
 * goes direct. straight over hills. rocks, other boats, land, sea, air, you
 * name it. also i did a few checks on the autoroute and it is banging at the
 * moment. so can we incorporate the autorouting into the plan your day
 * thingy." His account only in 127 (pydRouting.ts), on a tap, with the time
 * it took shown to him so he can decide on route-on-open.
 *
 * Memory only: the proposal, its disclosure, the routed line and the timing
 * live in the sheet for its life; nothing chart-derived is written anywhere
 * (o-charts, 2026-10-10). The one log line carries durations only.
 */
import type { AutoroutingTrialRequest, AutoroutingTrialRoute, ThalassaRouteDisclosure } from '../../types/autorouting';
import type { VesselProfile } from '../../types/vessel';
import { snapshotAutoroutingVesselProfile } from '../autoroutingVesselProfile';
import { getPairing } from '../PiPairingService';
import { routeLengthNm } from '../routeProgress';
import { createLogger } from '../../utils/createLogger';
import type { LatLon, RoutedLeg } from './places';

const log = createLogger('pydRoute');

const TO = ' to route round the land.';
/** What the route row says, before, during and when it cannot route (127-PYD-2's table). */
export const STOP_ROUTE_WORDS = {
    notYet: 'Not routed yet: takes a few seconds.',
    finding: 'Finding the way round the land…',
    queued: 'Waiting for the route before this one…',
    signedOut: `Sign in${TO}`,
    boat: `Set your boat's draft${TO}`,
    off: `Turn on Auto route (trial)${TO}`,
    draft: `Confirm your draft${TO}`,
    failed: 'Thalassa could not route this passage.',
};

export type StopRouteAction = 'preferences' | 'vessel' | 'confirm-draft';
export type StopRouteGate = { ok: true } | { ok: false; words: string | null; action?: StopRouteAction };

/**
 * Who may route, in order: the audience first (a tester gets nothing that
 * offers routing), then signed in, her own boat, the Auto route (trial)
 * switch, and her draft confirmed. Pure.
 */
export function stopRouteGate(a: {
    audience: boolean;
    signedIn: boolean;
    defaultBoat: boolean;
    switchOn: boolean;
    draftConfirmed: boolean;
}): StopRouteGate {
    const W = STOP_ROUTE_WORDS;
    if (!a.audience) return { ok: false, words: null };
    if (!a.signedIn) return { ok: false, words: W.signedOut };
    if (a.defaultBoat) return { ok: false, words: W.boat, action: 'vessel' };
    if (!a.switchOn) return { ok: false, words: W.off, action: 'preferences' };
    if (!a.draftConfirmed) return { ok: false, words: W.draft, action: 'confirm-draft' };
    return { ok: true };
}

export interface StopRouteRequest {
    /** The stop's id: the sheet's routes are kept by it. */
    id: string;
    start: LatLon;
    stop: LatLon;
    /** Their names as she reads them, for the no-chart sentence. */
    startName: string;
    stopName: string;
    draftM: number;
    speedKts: number;
    vessel: Partial<VesselProfile> | null | undefined;
    /** The leave she chose (the stop page's chip), else the best one. */
    departureMs: number;
}

export type StopRouteResult =
    | { kind: 'routed'; proposal: AutoroutingTrialRoute; leg: RoutedLeg; wallMs: number }
    | { kind: 'no-route'; words: string; wallMs: number };

export interface StopRouteDeps {
    /** Auto's provider; a fixture's fake in tests. */
    calculate?: (
        request: AutoroutingTrialRequest,
        signal?: AbortSignal,
        onProgress?: (message: string) => void,
    ) => Promise<AutoroutingTrialRoute>;
    /** A Pi is paired with this phone. */
    piPaired?: () => Promise<boolean>;
    clock?: () => number;
}

const ADD = `: add charts for this area${TO}`;
const noChart = (place: string) => `No chart for ${place} on this phone${ADD}`;
/** Auto's provider, loaded on the tap (127-PYD-common: PYD imports Auto's code dynamically), from one place. */
const provider = () => import('../autoroutingThalassa');

/**
 * One stop, through Auto's provider. Resolves 'routed' with the proposal and
 * its line, or 'no-route' with one plain sentence (words only: no line, no
 * coordinates); both with the wall time from the call to the result, which is
 * what she waits through. Rejects with the AbortError on a stop or an account
 * change, so nothing is shown.
 */
export async function routeStop(
    req: StopRouteRequest,
    opts: { signal: AbortSignal; onProgress?: (words: string) => void },
    deps: StopRouteDeps = {},
): Promise<StopRouteResult> {
    const clock = deps.clock ?? (() => performance.now());
    const t0 = clock();
    opts.onProgress?.(STOP_ROUTE_WORDS.finding);
    const ms = () => clock() - t0;
    let auto: Awaited<ReturnType<typeof provider>> | null = null;
    try {
        const calculate = deps.calculate ?? (auto = await provider()).calculateThalassaProposal;
        opts.signal.throwIfAborted();
        // The provider validates and copies the pins before any work.
        const proposal = await calculate(
            {
                departure: req.start,
                destination: req.stop,
                draftM: req.draftM,
                speedKts: req.speedKts,
                vesselProfile: snapshotAutoroutingVesselProfile(req.vessel),
                departureMs: req.departureMs,
            },
            opts.signal,
            opts.onProgress,
        );
        const wallMs = ms();
        const points = proposal.coordinates.map(([lon, lat]) => ({ lat, lon }));
        const lengthNm = routeLengthNm(points);
        log.warn(`[pyd] route took ${Math.round(wallMs)} ms, router ${Math.round(proposal.engine?.elapsedMs ?? 0)} ms`);
        return {
            kind: 'routed',
            proposal,
            leg: {
                basis: 'routed',
                factor: 1,
                straightNm: routeLengthNm([req.start, req.stop]),
                nm: proposal.engine?.distanceNM ?? lengthNm,
                route: { name: '', points, lengthNm },
            },
            wallMs,
        };
    } catch (error) {
        if (opts.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
        const wallMs = ms();
        log.warn(`[pyd] no route after ${Math.round(wallMs)} ms`);
        const said = error instanceof Error && error.message ? error.message : STOP_ROUTE_WORDS.failed;
        // The provider's coverage gate runs before any cloud fill, for a NOAA user too, who has no Pi:
        // said in words true for every boat.
        const end = /^No installed chart covers the (departure or the destination|departure|destination)\.$/.exec(said);
        // The module already loaded on the tap; a fixture's provider looks it up here (a failed load is no match).
        const bucket = (auto ?? (await provider().catch(() => null)))?.THALASSA_BUCKET_UNREACHABLE;
        const words = end
            ? noChart(
                  end[1] === 'destination'
                      ? req.stopName
                      : end[1] === 'departure'
                        ? req.startName
                        : `${req.startName} or ${req.stopName}`,
              )
            : // Past the coverage gate both ends are charted: the gap is on the way.
              said === bucket && !(await (deps.piPaired ?? (async () => !!getPairing()))())
              ? `No chart on this phone for the way to ${req.stopName}${ADD}`
              : said;
        return { kind: 'no-route', words, wallMs };
    }
}

/** The sheet's key for a route: the stop, the start to 5 dp, the draft to the centimetre. */
export function stopRouteKey(id: string, start: LatLon, draftM: number): string {
    return `${id}|${start.lat.toFixed(5)},${start.lon.toFixed(5)}|${draftM.toFixed(2)}`;
}

const nmOf = (m: number) => Math.max(0.1, m / 1852).toFixed(1);

/**
 * The route row, from the disclosure's own fields only (never a warning
 * sentence): "Routed on your charts · 16.5 NM each way", then at most two
 * findings, unverified first, then the satellite check, the tides, shallow
 * water, a pin's tail, and bridges no chart gives a height for.
 */
export function routeRowWords(engine: ThalassaRouteDisclosure | undefined, nm: number): string {
    const found: string[] = [];
    if (!engine || engine.stateMask === null) found.push('not verified: recalculate in Auto');
    if (engine?.backstop === 'unavailable') found.push('satellite land check not done');
    if (engine?.tideCheck === 'not-loaded') found.push("tides didn't load: shallow water not cleared");
    const runs = engine?.shallowRuns ?? [];
    const tails = runs.filter((r) => r.endpointTail || r.dryTail);
    const shallowM = runs.reduce((sum, r) => (tails.includes(r) ? sum : sum + r.lengthM), 0);
    if (shallowM > 0) found.push(`${nmOf(shallowM)} NM shallow`);
    for (const r of tails)
        found.push(
            r.dryTail
                ? 'the pin dries'
                : `${r.endpointTail === 'origin' ? 'first' : 'last'} ${nmOf(r.lengthM)} NM shallow`,
        );
    const cells = engine?.structuresUnknownCells?.length ?? 0;
    if (cells) found.push(`bridge heights not charted in ${cells} chart${cells > 1 ? 's' : ''}`);
    return ['Routed on your charts', `${nm.toFixed(1)} NM each way`, ...found.slice(0, 2)].join(' · ');
}

/** The owner's reading (decision 2): "Routed in 6.4 s · router 4.1 s", or "No route after 12.3 s". */
export function routeTimingLine(result: StopRouteResult): string {
    const s = (ms: number) => (ms / 1000).toFixed(1);
    return result.kind === 'routed'
        ? `Routed in ${s(result.wallMs)} s · router ${s(result.proposal.engine?.elapsedMs ?? 0)} s`
        : `No route after ${s(result.wallMs)} s`;
}

/** A route as the sheet holds it: waiting its turn, running (the provider's words), or done. */
export type RouteState = { id: string } & (
    | { kind: 'queued' | 'routing'; since: number; words: string }
    | StopRouteResult
);

export interface StopRouteQueue {
    readonly states: ReadonlyMap<string, RouteState>;
    /** A tap: a route already in, waiting or running asks nothing; the latest tap wins the one waiting place. */
    request(key: string, req: StopRouteRequest): void;
    /** Her page closed: a waiting route is dropped, a running one stopped, a no-route forgotten (the next tap tries again). A route stays. */
    cancel(key: string): void;
    /** A new start, or the sheet closing: everything stopped and forgotten. */
    clear(): void;
    /** A kept route refused afterwards (Auto's chart: satellite land, 127-PYD-3) is no route, in its words. */
    refuse(key: string, words: string): void;
}

/**
 * The hour Auto's chart shows a routed stop at, and the one the main chart is
 * given (127-PYD-3): the leave she chose on her stop page, never in the past
 * (a leave gone by while the sheet stayed open is now, as routing asks); with
 * none chosen, the leave it was routed for.
 */
export function chartLeave(chosenMs: number | null, routedMs: number | undefined, nowMs: number): number | null {
    return chosenMs !== null ? Math.max(chosenMs, nowMs) : (routedMs ?? null);
}

/**
 * One route at a time, at most one waiting, in memory for the sheet's life.
 * A route is kept; a no-route goes when its page closes, so re-opening it
 * offers the tap again (a dropped link, charts added since). Nothing starts
 * for a page that has closed, and a result that lands after a stop or an
 * account change is dropped.
 */
export function stopRouteQueue(
    run: (
        req: StopRouteRequest,
        opts: { signal: AbortSignal; onProgress?: (words: string) => void },
    ) => Promise<StopRouteResult>,
    onChange: () => void,
    options: { current?: () => boolean; now?: () => number } = {},
): StopRouteQueue {
    const states = new Map<string, RouteState>();
    const now = options.now ?? Date.now;
    let running: { key: string; stop: AbortController } | null = null;
    let waiting: { key: string; req: StopRouteRequest } | null = null;
    const set = (key: string, state: RouteState) => {
        states.set(key, state);
        onChange();
    };
    const drop = (key: string) => states.delete(key) && onChange();
    const next = () => {
        if (running || !waiting) return;
        const { key, req } = waiting;
        waiting = null;
        const stop = new AbortController();
        const mine = { key, stop };
        running = mine;
        const since = states.get(key)?.kind === 'queued' ? (states.get(key) as { since: number }).since : now();
        const live = () => !stop.signal.aborted && (options.current?.() ?? true);
        set(key, { id: req.id, kind: 'routing', since, words: STOP_ROUTE_WORDS.finding });
        run(req, {
            signal: stop.signal,
            onProgress: (words) => live() && set(key, { id: req.id, kind: 'routing', since, words }),
        })
            .then(
                (result) => live() && set(key, { id: req.id, ...result }),
                // Anything but a stop (a chunk that would not load): no route, never a row that ticks forever.
                () =>
                    live() &&
                    set(key, { id: req.id, kind: 'no-route', words: STOP_ROUTE_WORDS.failed, wallMs: now() - since }),
            )
            .finally(() => {
                if (running === mine) running = null;
                next();
            });
    };
    return {
        states,
        request(key, req) {
            const was = states.get(key)?.kind;
            if (was && was !== 'no-route') return;
            if (waiting) drop(waiting.key);
            waiting = { key, req };
            set(key, { id: req.id, kind: 'queued', since: now(), words: STOP_ROUTE_WORDS.queued });
            next();
        },
        cancel(key) {
            if (waiting?.key === key) waiting = null;
            if (running?.key === key) running.stop.abort();
            if (states.get(key)?.kind !== 'routed') drop(key);
        },
        clear() {
            waiting = null;
            running?.stop.abort();
            states.clear();
            onChange();
        },
        refuse(key, words) {
            const was = states.get(key);
            if (was?.kind === 'routed') set(key, { id: was.id, kind: 'no-route', words, wallMs: was.wallMs });
        },
    };
}
