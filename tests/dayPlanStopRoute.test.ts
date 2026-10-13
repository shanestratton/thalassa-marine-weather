/**
 * Plan Your Day routes the stop she opens (127-PYD-2), through Auto's own
 * provider and nothing else (services/dayPlanner/stopRoute.ts).
 *
 * Shane, 2026-10-10: "when you select somewhere, and plot on the chart. it
 * goes direct. straight over hills. rocks, other boats, land, sea, air, you
 * name it. also i did a few checks on the autoroute and it is banging at the
 * moment. so can we incorporate the autorouting into the plan your day
 * thingy." His decisions the same day: his account only in 127, the "Route
 * round the land" tap, and 127 shows him the routing time.
 *
 * A fake provider records what it was asked; the gate, the words, the queue
 * and the timing are the real ones. One case runs the REAL provider with the
 * engine stubbed to cross charted land: Plan Your Day says Auto's refusal and
 * draws nothing. Fictional pins (open water off Horta, in the Solent and off
 * Brittany); no chart data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    warn: vi.fn(),
    tryInshoreRoute: vi.fn(),
    crossesLand: vi.fn(),
    trialOn: true,
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: m.warn, error: vi.fn() }),
}));
// Only the integration case reaches these: the real provider, the engine stubbed.
vi.mock('../services/InshoreRouter', () => ({
    tryInshoreRoute: m.tryInshoreRoute,
    hasEncCoverageForRoute: () => true,
    MAX_INSHORE_NM: 50,
}));
vi.mock('../services/routing/landBackstop', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    inshoreRouteCrossesLand: m.crossesLand,
}));
vi.mock('../services/enc/cloudCellSync', () => ({ downloadCloudCellsForBBox: vi.fn() }));
vi.mock('../services/ntmRouting', () => ({ packsForCorridor: async () => [] }));
vi.mock('../services/localNotices', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    loadLocalNotices: async () => [],
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ settings: { autorouteTrialEnabled: m.trialOn } }) },
}));

import {
    STOP_ROUTE_WORDS,
    routeRowWords,
    routeStop,
    routeTimingLine,
    stopRouteGate,
    stopRouteKey,
    stopRouteQueue,
    type StopRouteRequest,
    type StopRouteResult,
} from '../services/dayPlanner/stopRoute';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import type { AutoroutingTrialRequest, AutoroutingTrialRoute, ThalassaRouteDisclosure } from '../types/autorouting';
import type { ShallowRunInfo } from '../services/engine/types';

// Open water off Horta, Faial (fictional pins; no chart data).
const START = { lat: 38.53, lon: -28.62 };
const STOP = { lat: 38.58, lon: -28.7 };
// The provider takes a leave within -1 h .. +8 days of now: two hours from now, on the hour.
const DEPART = Math.ceil((Date.now() + 2 * 3_600_000) / 3_600_000) * 3_600_000;

const request = (over: Partial<StopRouteRequest> = {}): StopRouteRequest => ({
    id: 'fixture-stop',
    start: START,
    stop: STOP,
    startName: 'Fixture Marina',
    stopName: 'Fixture Cove',
    draftM: 2.4,
    speedKts: 6,
    vessel: { draft: 7.87, draftConfirmedFt: 7.87, airDraft: 59 },
    departureMs: DEPART,
    ...over,
});

const disclosure = (over: Partial<ThalassaRouteDisclosure> = {}): ThalassaRouteDisclosure => ({
    stateMask: ['green', 'green'],
    cellsUsed: ['OC-99-SYN001'],
    distanceNM: 5.43,
    elapsedMs: 4100,
    backstop: 'verified',
    ...over,
});

const proposal = (engine: ThalassaRouteDisclosure = disclosure()): AutoroutingTrialRoute => ({
    id: 'thalassa-fixture',
    coordinates: [
        [START.lon, START.lat],
        [-28.68, 38.53],
        [STOP.lon, STOP.lat],
    ],
    warnings: ['Planned only.', 'A named dry stretch at Fixture Bank: red whatever the tide.'],
    createdAt: new Date(DEPART).toISOString(),
    provider: 'Thalassa',
    engine,
});

/** A clock that reads 0 at the start and `ms` at the end. */
const clockOf = (...readings: number[]) => {
    let i = 0;
    return () => readings[Math.min(i++, readings.length - 1)];
};

const run = (calculate: (r: AutoroutingTrialRequest, s?: AbortSignal) => Promise<AutoroutingTrialRoute>, over = {}) =>
    routeStop(request(over), { signal: new AbortController().signal }, { calculate, clock: clockOf(0, 6400) });

beforeEach(() => {
    m.warn.mockReset();
    m.trialOn = true;
});
afterEach(() => setAuthIdentityScope(null));

describe('who is offered routing, and the gates in order', () => {
    const all = { audience: true, signedIn: true, defaultBoat: false, switchOn: true, draftConfirmed: true };

    it('a tester gets nothing that offers routing: no words, no action', () => {
        for (const over of [{}, { signedIn: false }, { switchOn: false }, { draftConfirmed: false }])
            expect(stopRouteGate({ ...all, ...over, audience: false })).toEqual({ ok: false, words: null });
    });

    it("the owner: signed in, then her own boat, then the switch, then the draft, each in the table's words", () => {
        expect(stopRouteGate(all)).toEqual({ ok: true });
        expect(stopRouteGate({ ...all, signedIn: false, defaultBoat: true, switchOn: false })).toEqual({
            ok: false,
            words: 'Sign in to route round the land.',
        });
        expect(stopRouteGate({ ...all, defaultBoat: true, switchOn: false })).toEqual({
            ok: false,
            words: "Set your boat's draft to route round the land.",
            action: 'vessel',
        });
        expect(stopRouteGate({ ...all, switchOn: false, draftConfirmed: false })).toEqual({
            ok: false,
            words: 'Turn on Auto route (trial) to route round the land.',
            action: 'preferences',
        });
        expect(stopRouteGate({ ...all, draftConfirmed: false })).toEqual({
            ok: false,
            words: 'Confirm your draft to route round the land.',
            action: 'confirm-draft',
        });
    });

    it('says what it is before the tap, and what it does on it', () => {
        expect(STOP_ROUTE_WORDS.notYet).toBe('Not routed yet: takes a few seconds.');
        expect(STOP_ROUTE_WORDS.finding).toBe('Finding the way round the land…');
    });
});

describe("routeStop: Auto's provider, the provider's words", () => {
    it('asks the provider with her pins, draft, boat and the chosen leave, and keeps the routed line', async () => {
        const calculate = vi.fn(async () => proposal());
        const progress = vi.fn();
        const result = await routeStop(
            request(),
            { signal: new AbortController().signal, onProgress: progress },
            { calculate, clock: clockOf(0, 6400) },
        );
        expect(calculate).toHaveBeenCalledOnce();
        const [asked, signal] = calculate.mock.calls[0] as unknown as [AutoroutingTrialRequest, AbortSignal];
        expect(asked).toMatchObject({
            departure: START,
            destination: STOP,
            draftM: 2.4,
            speedKts: 6,
            departureMs: DEPART,
            vesselProfile: { draftStatus: 'measured', airDraft: { status: 'measured' } },
        });
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(progress).toHaveBeenNthCalledWith(1, 'Finding the way round the land…');
        expect(result.kind).toBe('routed');
        if (result.kind !== 'routed') return;
        expect(result.wallMs).toBe(6400);
        expect(result.leg).toMatchObject({ basis: 'routed', factor: 1, nm: 5.43 });
        expect(result.leg.route.points).toEqual([START, { lat: 38.53, lon: -28.68 }, STOP]);
        expect(result.leg.straightNm).toBeGreaterThan(0);
    });

    it('"No installed chart covers …" becomes the global sentence, naming the place and never a Pi', async () => {
        const cases: [string, string][] = [
            ['No installed chart covers the destination.', 'Fixture Cove'],
            ['No installed chart covers the departure.', 'Fixture Marina'],
            ['No installed chart covers the departure or the destination.', 'Fixture Marina or Fixture Cove'],
        ];
        for (const [refusal, place] of cases) {
            const result = await run(async () => {
                throw new Error(refusal);
            });
            expect(result).toEqual({
                kind: 'no-route',
                words: `No chart for ${place} on this phone: add charts for this area to route round the land.`,
                wallMs: 6400,
            });
            expect(result.kind === 'no-route' && result.words).not.toMatch(/\bPi\b/);
        }
    });

    it("Auto's charts-from-the-Pi refusal is the global sentence too when no Pi is paired (the gap is on the way), and Auto's own with one", async () => {
        const { THALASSA_BUCKET_UNREACHABLE } = await import('../services/autoroutingThalassa');
        const refuse = async () => {
            throw new Error(THALASSA_BUCKET_UNREACHABLE);
        };
        const unpaired = await routeStop(
            request(),
            { signal: new AbortController().signal },
            { calculate: refuse, clock: clockOf(0, 900), piPaired: async () => false },
        );
        // Past the coverage gate both ends are charted: never "No chart for Fixture Cove".
        expect(unpaired.kind === 'no-route' && unpaired.words).toBe(
            'No chart on this phone for the way to Fixture Cove: add charts for this area to route round the land.',
        );
        const paired = await routeStop(
            request(),
            { signal: new AbortController().signal },
            { calculate: refuse, clock: clockOf(0, 900), piPaired: async () => true },
        );
        expect(paired.kind === 'no-route' && paired.words).toBe(THALASSA_BUCKET_UNREACHABLE);
    });

    it.each([
        'Routing took longer than this phone allows (85 s). Try a shorter passage. Nothing changed.',
        'Route not possible: a bridge with 12.0 m clearance blocks your 18.0 m air draft.',
        'No route by water to your destination: the nearest water Thalassa could reach is 650 m from the pin. Nothing changed.',
        'Auto routes inshore passages up to 50 NM; this one is 61.2 NM. Split it, or plot it in Manual.',
    ])('an engine or Auto refusal passes through whole: %s', async (refusal) => {
        const result = await run(async () => {
            throw new Error(refusal);
        });
        expect(result).toEqual({ kind: 'no-route', words: refusal, wallMs: 6400 });
    });

    it('on every failure the result carries words only: no coordinates, no proposal, no line', async () => {
        for (const refusal of [
            'No installed chart covers the destination.',
            'Thalassa could not route this passage.',
        ]) {
            const result = await run(async () => {
                throw new Error(refusal);
            });
            expect(Object.keys(result).sort()).toEqual(['kind', 'wallMs', 'words']);
            expect(JSON.stringify(result)).not.toMatch(/-?\d+\.\d{3,}/);
        }
    });

    it('a stop or an account change rejects with the AbortError, so nothing is shown', async () => {
        const controller = new AbortController();
        const pending = routeStop(
            request(),
            { signal: controller.signal },
            {
                calculate: (_r, signal) =>
                    new Promise((_resolve, reject) =>
                        signal!.addEventListener('abort', () =>
                            reject(new DOMException('Auto routing was cancelled.', 'AbortError')),
                        ),
                    ),
            },
        );
        await Promise.resolve();
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('measures the wall time on both kinds, and logs one warn line of durations only', async () => {
        const routed = await run(async () => proposal());
        expect(routed.wallMs).toBe(6400);
        const refused = await run(async () => {
            throw new Error('No installed chart covers the destination.');
        });
        expect(refused.wallMs).toBe(6400);
        const lines = m.warn.mock.calls.map((c) => String(c[0]));
        expect(lines).toEqual(['[pyd] route took 6400 ms, router 4100 ms', '[pyd] no route after 6400 ms']);
        // Durations only: no position, name or depth in the log (common licence rule 3).
        for (const line of lines) {
            expect(line).not.toMatch(/-?\d+\.\d{3,}/);
            expect(line).not.toMatch(/Fixture|Cove|Marina/);
        }
    });
});

describe('the cache key', () => {
    it('is the stop, the start to 5 dp and the draft to the centimetre', () => {
        const key = stopRouteKey('fixture-stop', START, 2.4);
        expect(key).toBe(stopRouteKey('fixture-stop', { lat: 38.530001, lon: -28.620004 }, 2.4012));
        expect(key).not.toBe(stopRouteKey('fixture-stop', { lat: 38.5301, lon: -28.62 }, 2.4));
        expect(key).not.toBe(stopRouteKey('fixture-stop', START, 2.41));
        expect(key).not.toBe(stopRouteKey('other-stop', START, 2.4));
    });
});

describe('the route row: the real disclosure fields, at most two findings', () => {
    const shallow = (over: Partial<ShallowRunInfo>): ShallowRunInfo => ({
        startSeg: 0,
        endSeg: 0,
        lengthM: 556,
        minDepthM: 1.8,
        midLat: 50.75,
        midLon: -1.3,
        ...over,
    });
    const words = (over: Partial<ThalassaRouteDisclosure>) => routeRowWords(disclosure(over), 16.5);

    it('a clean route: the distance once, no "about"', () => {
        expect(words({})).toBe('Routed on your charts · 16.5 NM each way');
    });

    it('shallow water, its pin tails left out of the total and said apart', () => {
        expect(words({ shallowRuns: [shallow({}), shallow({ endpointTail: 'destination', lengthM: 370 })] })).toBe(
            'Routed on your charts · 16.5 NM each way · 0.3 NM shallow · last 0.2 NM shallow',
        );
        expect(words({ shallowRuns: [shallow({ endpointTail: 'origin', lengthM: 370 })] })).toBe(
            'Routed on your charts · 16.5 NM each way · first 0.2 NM shallow',
        );
        expect(words({ shallowRuns: [shallow({ endpointTail: 'destination', dryTail: true })] })).toBe(
            'Routed on your charts · 16.5 NM each way · the pin dries',
        );
        expect(words({ shallowRuns: [shallow({ dryTail: true }), shallow({ lengthM: 185 })] })).toBe(
            'Routed on your charts · 16.5 NM each way · 0.1 NM shallow · the pin dries',
        );
    });

    it('precedence 1 > 2 > 3 > 4 > 5 > 6, two at most', () => {
        const everything: Partial<ThalassaRouteDisclosure> = {
            stateMask: null,
            backstop: 'unavailable',
            tideCheck: 'not-loaded',
            shallowRuns: [shallow({}), shallow({ endpointTail: 'destination' })],
            structuresUnknownCells: ['OC-99-SYN001'],
        };
        const steps = [
            'not verified: recalculate in Auto',
            'satellite land check not done',
            "tides didn't load: shallow water not cleared",
            '0.3 NM shallow',
            'last 0.3 NM shallow',
            'bridge heights not charted in 1 chart',
        ];
        expect(words(everything)).toBe(`Routed on your charts · 16.5 NM each way · ${steps[0]} · ${steps[1]}`);
        expect(words({ ...everything, stateMask: ['green'] })).toBe(
            `Routed on your charts · 16.5 NM each way · ${steps[1]} · ${steps[2]}`,
        );
        expect(words({ ...everything, stateMask: ['green'], backstop: 'verified' })).toBe(
            `Routed on your charts · 16.5 NM each way · ${steps[2]} · ${steps[3]}`,
        );
        expect(words({ ...everything, stateMask: ['green'], backstop: 'verified', tideCheck: undefined })).toBe(
            `Routed on your charts · 16.5 NM each way · ${steps[3]} · ${steps[4]}`,
        );
        expect(words({ structuresUnknownCells: ['OC-99-SYN001', 'OC-99-SYN002'] })).toBe(
            'Routed on your charts · 16.5 NM each way · bridge heights not charted in 2 charts',
        );
    });

    it('offline at sea never reads as a clean "Routed"', () => {
        expect(words({ backstop: 'unavailable', tideCheck: 'not-loaded' })).toBe(
            "Routed on your charts · 16.5 NM each way · satellite land check not done · tides didn't load: shallow water not cleared",
        );
    });

    it('no word comes from the warnings', () => {
        const route = proposal(disclosure());
        expect(routeRowWords(route.engine, 16.5)).not.toMatch(/Fixture Bank|Planned only/);
    });
});

describe('the owner timing line', () => {
    it('"Routed in 6.4 s · router 4.1 s", or "No route after 12.3 s"', () => {
        const routed: StopRouteResult = {
            kind: 'routed',
            proposal: proposal(),
            leg: { basis: 'routed', factor: 1, straightNm: 4, nm: 5.4, route: { name: '', points: [], lengthNm: 5.4 } },
            wallMs: 6400,
        };
        expect(routeTimingLine(routed)).toBe('Routed in 6.4 s · router 4.1 s');
        expect(routeTimingLine({ kind: 'no-route', words: 'x', wallMs: 12_340 })).toBe('No route after 12.3 s');
    });
});

describe('one route at a time, memory only, nothing stale', () => {
    type Started = { req: StopRouteRequest; signal: AbortSignal; settle: (r: StopRouteResult) => void };
    const setup = (current = () => true) => {
        const started: Started[] = [];
        const runRoute = vi.fn(
            (req: StopRouteRequest, opts: { signal: AbortSignal; onProgress?: (w: string) => void }) =>
                new Promise<StopRouteResult>((resolve, reject) => {
                    started.push({ req, signal: opts.signal, settle: resolve });
                    opts.onProgress?.('Routing round the land…');
                    opts.signal.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')));
                }),
        );
        const onChange = vi.fn();
        const queue = stopRouteQueue(runRoute, onChange, { current, now: () => 1000 });
        return { started, runRoute, onChange, queue };
    };
    const noRoute = (words = 'No route.'): StopRouteResult => ({ kind: 'no-route', words, wallMs: 10 });
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    it('a second request while one runs waits; a third replaces the waiting one (latest tap wins)', async () => {
        const { started, queue } = setup();
        queue.request('a', request({ id: 'a' }));
        queue.request('b', request({ id: 'b' }));
        queue.request('c', request({ id: 'c' }));
        expect(started.map((s) => s.req.id)).toEqual(['a']);
        expect(queue.states.get('a')).toMatchObject({ kind: 'routing', id: 'a', words: 'Routing round the land…' });
        expect(queue.states.get('b')).toBeUndefined();
        expect(queue.states.get('c')).toMatchObject({ kind: 'queued', id: 'c', since: 1000 });
        started[0].settle(noRoute());
        await flush();
        expect(queue.states.get('a')).toMatchObject({ kind: 'no-route', id: 'a' });
        expect(started.map((s) => s.req.id)).toEqual(['a', 'c']);
    });

    it('closing a page removes its waiting request and aborts its running one; nothing starts for a closed page', async () => {
        const { started, queue } = setup();
        queue.request('a', request({ id: 'a' }));
        queue.request('b', request({ id: 'b' }));
        queue.cancel('b');
        expect(queue.states.get('b')).toBeUndefined();
        queue.cancel('a');
        expect(started[0].signal.aborted).toBe(true);
        expect(queue.states.get('a')).toBeUndefined();
        await flush();
        expect(started).toHaveLength(1);
        // Re-opening a cancelled one shows the button again; a tap starts a fresh run.
        queue.request('a', request({ id: 'a' }));
        expect(started).toHaveLength(2);
        expect(started[1].signal.aborted).toBe(false);
    });

    it('a route that finishes is kept for the sheet: closing its page leaves it, a second tap asks nothing', async () => {
        const { started, queue } = setup();
        queue.request('a', request({ id: 'a' }));
        started[0].settle({ kind: 'routed', proposal: proposal(), leg: {} as never, wallMs: 10 });
        await flush();
        queue.cancel('a');
        expect(queue.states.get('a')).toMatchObject({ kind: 'routed' });
        queue.request('a', request({ id: 'a' }));
        expect(started).toHaveLength(1);
    });

    it('a no-route can be tried again: a tap replaces it, and closing its page forgets it', async () => {
        // Review 2026-10-11: a dropped link's "try again" stuck for the sheet's life.
        const { started, queue } = setup();
        queue.request('a', request({ id: 'a' }));
        started[0].settle(noRoute('Check your connection, then try again.'));
        await flush();
        expect(queue.states.get('a')).toMatchObject({ kind: 'no-route' });
        queue.request('a', request({ id: 'a' }));
        expect(started).toHaveLength(2);
        started[1].settle(noRoute('Still no.'));
        await flush();
        queue.cancel('a');
        expect(queue.states.get('a')).toBeUndefined();
        queue.request('a', request({ id: 'a' }));
        expect(started).toHaveLength(3);
    });

    it('a run that rejects with anything but a stop ends as no route, never a row that ticks for ever', async () => {
        // Review 2026-10-11: a provider chunk that would not load (a stale web deploy) left "routing" for good.
        const queue = stopRouteQueue(
            async () => {
                throw new TypeError('Failed to fetch dynamically imported module');
            },
            vi.fn(),
            { now: clockOf(1000, 3500) },
        );
        queue.request('a', request({ id: 'a' }));
        await flush();
        expect(queue.states.get('a')).toEqual({
            id: 'a',
            kind: 'no-route',
            words: 'Thalassa could not route this passage.',
            wallMs: 2500,
        });
        // A stop still shows nothing.
        const stopped = stopRouteQueue(
            (_r, opts) =>
                new Promise((_resolve, reject) =>
                    opts.signal.addEventListener('abort', () => reject(new TypeError('stopped'))),
                ),
            vi.fn(),
        );
        stopped.request('b', request({ id: 'b' }));
        stopped.cancel('b');
        await flush();
        expect(stopped.states.get('b')).toBeUndefined();
    });

    it('a result after an abort or an account change is dropped', async () => {
        let current = true;
        const { started, queue } = setup(() => current);
        queue.request('a', request({ id: 'a' }));
        current = false;
        started[0].settle(noRoute());
        await flush();
        expect(queue.states.get('a')).not.toMatchObject({ kind: 'no-route' });
    });

    it('clear (a new start, the sheet closing) stops the run and forgets everything', async () => {
        const { started, queue } = setup();
        queue.request('a', request({ id: 'a' }));
        queue.request('b', request({ id: 'b' }));
        queue.clear();
        expect(started[0].signal.aborted).toBe(true);
        expect(queue.states.get('a')).toBeUndefined();
        expect(queue.states.get('b')).toBeUndefined();
        await flush();
        expect(started).toHaveLength(1);
    });

    it('closing a page while its route runs aborts the very signal the provider was given, and nothing is drawn', async () => {
        const seen: AbortSignal[] = [];
        const onChange = vi.fn();
        const queue = stopRouteQueue(
            (req, opts) =>
                routeStop(req, opts, {
                    calculate: (_r, signal) =>
                        new Promise((_resolve, reject) => {
                            seen.push(signal!);
                            signal!.addEventListener('abort', () =>
                                reject(new DOMException('Auto routing was cancelled.', 'AbortError')),
                            );
                        }),
                }),
            onChange,
        );
        queue.request('a', request({ id: 'a' }));
        await vi.waitFor(() => expect(seen).toHaveLength(1));
        queue.cancel('a');
        expect(seen[0].aborted).toBe(true);
        await flush();
        expect(queue.states.get('a')).toBeUndefined();
    });
});

describe("through the real provider: Auto's charted-land refusal, and no line", () => {
    it('strict: a route across charted land is refused in Auto’s words, with nothing to draw', async () => {
        setAuthIdentityScope('user-fixture-1');
        m.tryInshoreRoute.mockResolvedValue({
            polyline: [
                [START.lon, START.lat],
                [-28.66, 38.55],
                [STOP.lon, STOP.lat],
            ],
            distanceNM: 5.1,
            cellsUsed: ['OC-99-SYN001'],
            elapsedMs: 900,
            hardLand: { totalM: 400, awayM: 400 },
        });
        m.crossesLand.mockResolvedValue({ status: 'verified', crossesLand: false, runs: [] });
        const result = await routeStop(request(), { signal: new AbortController().signal });
        expect(result).toMatchObject({
            kind: 'no-route',
            words: 'The only way Thalassa found crosses charted land. No route. Nothing changed.',
        });
        expect(result).not.toHaveProperty('proposal');
        expect(result).not.toHaveProperty('leg');
        // The leave she chose reached the engine through the provider.
        expect(m.tryInshoreRoute.mock.calls[0][5].departureMs).toBe(DEPART);
    });
});
