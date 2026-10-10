/**
 * Plan Your Day's handoff to the chart (build 124; 127-PYD-3).
 *
 * "Plot on chart" never draws a straight line: it loads the line Thalassa
 * routed round the land, or the skipper's own saved route, into the MANUAL
 * plotter as an unsaved draft; with neither, only the start and stop marks
 * and why ("Plot by hand"), with no dashed bearing hint. Nothing is saved
 * until the skipper saves. The request is identity-fenced like every other
 * tracer handoff: it carries the boat's position.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import {
    consumeTracerAction,
    consumeTracerOpenRequest,
    peekTracerOpenRequest,
    plotDayPins,
    PLOT_DAY_MAX_POINTS,
    requestTracerOpen,
    type TracerOpenAction,
    type TracerOpenEventDetail,
} from '../services/deepLink';
import { distanceEstimate, type PlaceCandidate, type SavedRouteMatch } from '../services/dayPlanner/places';
import { plotDayAction } from '../services/dayPlanner/today';
import { AUTOROUTING_PROPOSAL_MAX_POINTS } from '../services/autoroutingProposalEvidence';

const START = { lat: -20.265, lon: 148.719 };
const CID = { lat: -20.24511, lon: 148.94836 };

function candidate(over: Partial<PlaceCandidate> = {}): PlaceCandidate {
    return {
        id: 'osm-node3020491514',
        name: 'Cid Harbour',
        source: 'atlas',
        lat: CID.lat,
        lon: CID.lon,
        fetchLandNM: null,
        straightNm: 12.8,
        distance: distanceEstimate(START, CID, null),
        ...over,
    };
}

const SAVED: SavedRouteMatch = {
    name: 'Airlie → Cid',
    points: [START, { lat: -20.28, lon: 148.8 }, { lat: -20.26, lon: 148.9 }, CID],
    lengthNm: 14.8,
};

/** A routed line round the island (synthetic): what Auto's provider hands back. */
const ROUTED = [START, { lat: -20.29, lon: 148.78 }, { lat: -20.3, lon: 148.86 }, { lat: -20.27, lon: 148.92 }, CID];
const START_NAMED = { ...START, name: 'Airlie Bay' };
const WHY = 'No chart for Cid Harbour on this phone.';

describe('plotDayAction: Plot on chart never draws a straight line (127-PYD-3)', () => {
    it('with no routed line and no saved route: the two marks and why, and no line at all', () => {
        for (const stay of ['2h', 'overnight'] as const) {
            const action = plotDayAction(START_NAMED, candidate(), stay, { why: WHY });
            expect(action.points).toEqual([]);
            expect(action.routed).toBeUndefined();
            expect(action.frame).toEqual({
                from: { lat: START.lat, lon: START.lon, name: 'Airlie Bay' },
                to: { lat: CID.lat, lon: CID.lon, name: 'Cid Harbour' },
                why: WHY,
            });
        }
    });

    it('a routed line is plotted as routed: out and turned round for a day trip, one way overnight', () => {
        const day = plotDayAction(START_NAMED, candidate(), '4h', { routed: ROUTED });
        expect(day).toMatchObject({
            kind: 'plot-day',
            routed: true,
            name: 'Day out: Cid Harbour',
            stop: 'Cid Harbour',
        });
        expect(day.points).toEqual([...ROUTED, ...[...ROUTED].reverse().slice(1)]);
        expect(day.savedRoute).toBeUndefined();
        expect(day.frame).toBeUndefined();
        const night = plotDayAction(START_NAMED, candidate(), 'overnight', { routed: ROUTED });
        expect(night.points).toEqual(ROUTED);
        expect(night.name).toBe('Overnight: Cid Harbour');
    });

    it('never returns a two-point straight line for a stop that is not her saved route', () => {
        for (const stay of ['1h', '2h', '4h', 'overnight'] as const) {
            for (const opts of [{}, { why: WHY }, { routed: [] }, { routed: [START] }]) {
                const action = plotDayAction(START_NAMED, candidate(), stay, opts);
                expect(action.points).toEqual([]);
                expect(action.frame).toBeDefined();
            }
        }
    });

    it('a routed line too long to take there and back goes one way, with home by Reverse route', () => {
        const long = Array.from({ length: 12_000 }, (_, i) => ({
            lat: START.lat + ((CID.lat - START.lat) * i) / 11_999,
            lon: START.lon + ((CID.lon - START.lon) * i) / 11_999,
        }));
        const day = plotDayAction(START_NAMED, candidate(), '2h', { routed: long });
        expect(day.points).toHaveLength(12_000);
        expect(day.outOnly).toBe(true);
        expect(plotDayPins(day)).not.toBeNull();
    });

    it('a saved route that joins them is used as drawn, and turned round for the trip home', () => {
        const c = candidate({ distance: distanceEstimate(START, CID, null, SAVED) });
        const day = plotDayAction(START_NAMED, c, '4h');
        expect(day.savedRoute).toBe('Airlie → Cid');
        expect(day.points).toEqual([...SAVED.points, ...[...SAVED.points].reverse().slice(1)]);
        // The stop is not dropped twice.
        expect(day.points.filter((p) => p.lat === CID.lat && p.lon === CID.lon)).toHaveLength(1);
        const night = plotDayAction(START_NAMED, c, 'overnight');
        expect(night.points).toEqual(SAVED.points);
    });

    it('a long saved Auto route (300 points) plots there and back: the chart takes all 599 pins', () => {
        const route: SavedRouteMatch = {
            name: 'Auto: Airlie → Cid',
            points: Array.from({ length: 300 }, (_, i) => ({
                lat: START.lat + ((CID.lat - START.lat) * i) / 299,
                lon: START.lon + ((CID.lon - START.lon) * i) / 299,
            })),
            lengthNm: 14.8,
        };
        const day = plotDayAction(
            START_NAMED,
            candidate({ distance: distanceEstimate(START, CID, null, route) }),
            '2h',
        );
        expect(day.points).toHaveLength(599);
        expect(day.savedRoute).toBe('Auto: Airlie → Cid');
        expect(plotDayPins(day)?.points).toHaveLength(599);
        // As long as any saved route may be (saved_routes holds 10,000 points), there and back.
        expect(PLOT_DAY_MAX_POINTS).toBe(2 * AUTOROUTING_PROPOSAL_MAX_POINTS - 1);
    });

    it('a saved route too long to take there and back gives the two marks and says so, never straight pins', () => {
        const route: SavedRouteMatch = {
            name: 'Far too long',
            points: Array.from({ length: PLOT_DAY_MAX_POINTS }, (_, i) => ({
                lat: START.lat + ((CID.lat - START.lat) * i) / (PLOT_DAY_MAX_POINTS - 1),
                lon: START.lon + ((CID.lon - START.lon) * i) / (PLOT_DAY_MAX_POINTS - 1),
            })),
            lengthNm: 14.8,
        };
        const day = plotDayAction(
            START_NAMED,
            candidate({ distance: distanceEstimate(START, CID, null, route) }),
            '2h',
        );
        expect(day.points).toEqual([]);
        expect(day.savedRoute).toBeUndefined();
        expect(day.frame?.why).toBe('Your saved route is too long to plot here: open it from Saved Routes.');
        expect(plotDayPins(day)).not.toBeNull();
    });

    it('copies the points, so the plan cannot be edited through the chart', () => {
        const c = candidate({ distance: distanceEstimate(START, CID, null, SAVED) });
        const action = plotDayAction(START_NAMED, c, 'overnight');
        action.points[0].lat = 0;
        expect(SAVED.points[0].lat).toBe(START.lat);
        const routed = plotDayAction(START_NAMED, candidate(), 'overnight', { routed: ROUTED });
        routed.points[1].lat = 0;
        expect(ROUTED[1].lat).toBe(-20.29);
    });

    it('plots a place anywhere in the world the same way (Nouméa, no atlas)', () => {
        const noumea = { lat: -22.2758, lon: 166.458, name: 'Port Moselle' };
        const baie = { lat: -22.3201, lon: 166.4398 };
        const c = candidate({
            id: 'osm-node99',
            name: 'Baie de Maa',
            source: 'osm',
            ...baie,
            distance: distanceEstimate(noumea, baie, null),
        });
        const byHand = plotDayAction(noumea, c, '1h', { why: 'No chart for Baie de Maa on this phone.' });
        expect(byHand.points).toEqual([]);
        expect(byHand.frame?.to.name).toBe('Baie de Maa');
        const routed = [{ lat: noumea.lat, lon: noumea.lon }, { lat: -22.3, lon: 166.45 }, baie];
        expect(plotDayAction(noumea, c, '1h', { routed }).points).toEqual([
            ...routed,
            ...[...routed].reverse().slice(1),
        ]);
    });
});

describe('plotDayPins: what the chart accepts from a plot-day request', () => {
    const valid = plotDayAction(START_NAMED, candidate(), '2h', { routed: ROUTED });
    const frame = plotDayAction(START_NAMED, candidate(), '2h', { why: WHY });

    it('passes a good routed request through', () => {
        expect(plotDayPins(valid)).toEqual({
            points: valid.points,
            name: 'Day out: Cid Harbour',
            stop: 'Cid Harbour',
            savedRoute: null,
            routed: true,
            outOnly: false,
            frame: null,
        });
    });

    it('passes a frame with no points through, with both marks and why', () => {
        expect(plotDayPins(frame)).toEqual({
            points: [],
            name: 'Day out: Cid Harbour',
            stop: 'Cid Harbour',
            savedRoute: null,
            routed: false,
            outOnly: false,
            frame: frame.frame,
        });
    });

    it('refuses a frame with a bad position, a frame with pins, and no pins without a frame', () => {
        const bad = { ...frame.frame!, to: { ...frame.frame!.to, lat: 91 } };
        expect(plotDayPins({ ...frame, frame: bad })).toBeNull();
        expect(
            plotDayPins({ ...frame, frame: { ...frame.frame!, from: { lat: 1, lon: Number.NaN, name: 'x' } } }),
        ).toBeNull();
        expect(plotDayPins({ ...frame, points: [START, CID] })).toBeNull();
        expect(plotDayPins({ ...valid, points: [] })).toBeNull();
    });

    it('refuses fewer than two pins, a bad coordinate, or a runaway list', () => {
        expect(plotDayPins({ ...valid, points: [START] })).toBeNull();
        expect(plotDayPins({ ...valid, points: [START, { lat: Number.NaN, lon: 1 }] })).toBeNull();
        expect(plotDayPins({ ...valid, points: [START, { lat: 91, lon: 1 }] })).toBeNull();
        expect(plotDayPins({ ...valid, points: [START, { lat: 1, lon: 181 }] })).toBeNull();
        const many = Array.from({ length: PLOT_DAY_MAX_POINTS + 1 }, (_, i) => ({ lat: -20, lon: 148 + i / 1000 }));
        expect(plotDayPins({ ...valid, points: many })).toBeNull();
    });

    it('names a nameless request plainly rather than refusing it', () => {
        expect(plotDayPins({ ...valid, name: '  ', stop: '' })).toMatchObject({ name: 'Day out', stop: 'the stop' });
    });
});

function captureNextTracerEvent(): { read: () => CustomEvent<TracerOpenEventDetail> } {
    let captured: CustomEvent<TracerOpenEventDetail> | null = null;
    const listener = (event: Event) => {
        captured = event as CustomEvent<TracerOpenEventDetail>;
        window.removeEventListener('thalassa:trace-mode', listener);
    };
    window.addEventListener('thalassa:trace-mode', listener);
    return {
        read: () => {
            if (!captured) throw new Error('Expected a tracer event');
            return captured;
        },
    };
}

describe("the 'plot-day' tracer request", () => {
    beforeEach(() => {
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
    });
    afterEach(() => {
        setAuthIdentityScope(null);
    });

    const action: TracerOpenAction = plotDayAction(START_NAMED, candidate(), '2h', { routed: ROUTED });

    it('round-trips through requestTracerOpen and consumeTracerAction', () => {
        const event = captureNextTracerEvent();
        requestTracerOpen(action);
        expect(peekTracerOpenRequest()).toBe(true);
        expect(consumeTracerOpenRequest(event.read())).toBe(true);
        expect(consumeTracerAction()).toEqual(action);
        expect(consumeTracerAction()).toBeNull();
    });

    it("is dropped when the account changes before the chart takes it (it carries the boat's position)", () => {
        const event = captureNextTracerEvent();
        requestTracerOpen(action);
        setAuthIdentityScope('account-b');
        expect(consumeTracerOpenRequest(event.read())).toBe(false);
        expect(consumeTracerAction()).toBeNull();
    });

    it('is dropped after the chart claims it if the account changes before it is read', () => {
        const event = captureNextTracerEvent();
        requestTracerOpen(action);
        expect(consumeTracerOpenRequest(event.read())).toBe(true);
        setAuthIdentityScope('account-b');
        expect(consumeTracerAction()).toBeNull();
    });

    it('refuses a request staged under an earlier account', () => {
        const stale = getAuthIdentityScope();
        setAuthIdentityScope('account-b');
        requestTracerOpen(action, stale);
        expect(peekTracerOpenRequest()).toBe(false);
        expect(consumeTracerAction()).toBeNull();
    });
});

// MapHub is too heavy to render here; pin the branch's wiring instead (as
// MapHubReverseWiring.test.ts does for leg reversal).
describe('MapHub opens a plot-day request in the Manual plotter', () => {
    const code = readFileSync('components/map/MapHub.tsx', 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const start = code.indexOf("action?.kind === 'plot-day'");
    const branch = code.slice(start, code.indexOf('} else if (action?.kind', start + 10));

    it('has the branch, beside the other front-door actions', () => {
        expect(start).toBeGreaterThan(-1);
        expect(code.indexOf("action?.kind === 'load-saved'")).toBeGreaterThan(-1);
    });

    it('loads the pins as a fresh, unsaved draft and fits them on the chart', () => {
        expect(branch).toContain('plotDayPins(action)');
        expect(branch).toContain('setLegAnchor(null)');
        expect(branch).toContain('clearReturnContext()');
        expect(branch).toContain('rebaseHistoryRef.current = true');
        expect(branch).toContain('setCapturedCoords(plot.points)');
        expect(branch).toContain('setTraceName(plot.name)');
        expect(branch).toContain('setSavedTraces(loadSavedTraces())');
        expect(branch).toContain('fitTraceBounds(mapRef.current, points)');
        expect(branch).toContain('flyWhenReady(plot.frame ? [plot.frame.from, plot.frame.to] : plot.points)');
        expect(branch).toContain('tracerHandoffTimersRef.current.add(timer)');
        expect(branch).toContain('1_200');
        expect(branch).toContain('isAuthIdentityScopeCurrent(requestScope)');
        // Nothing is saved until the skipper saves.
        expect(branch).not.toMatch(/\bsaveTrace\(|commitTraceSave\(|decideTraceSave\(/);
    });

    it('never says "straight lines": a routed line, her saved route, or two marks and why', () => {
        expect(branch).not.toMatch(/Straight lines/);
        expect(branch).toContain(
            "`Plan Your Day's route to ${plot.stop}: Route report is checking it; Sail follows it, Save keeps it.${plot.outOnly ? ' Home: Reverse route.' : ''}`",
        );
        expect(branch).toContain('`Your saved route to ${plot.stop}: Route report checks it against your charts`');
        expect(branch).toContain('Drop pins round the land; Route report checks them.');
    });

    it('a Plan Your Day frame sets the two marks with its kind, so no straight hint is drawn', () => {
        expect(branch).toContain('setTraceOrigin(plot.frame?.from ?? null)');
        expect(branch).toContain('setTraceDest(plot.frame?.to ?? null)');
        expect(branch).toContain("if (plot.frame) setTraceFrameKind('day-plan')");
        expect(code).toContain("destHint: traceFrameKind !== 'day-plan'");
        // The parked course frame still says it is the course frame.
        expect(code).toMatch(
            /setTraceDest\(\{ lat: d\.lat, lon: d\.lon, name: d\.name \}\);\s*setTraceFrameKind\('course'\)/,
        );
    });

    it('marks a routed line as routed for the plotter (127-C-b reads it); other loads clear the mark', () => {
        expect(branch).toContain("if (plot.routed) setDraftSource('day-plan-route')");
        // The proven lane, a pending route and a saved route are not Plan Your Day's line.
        expect(code.match(/setCapturedCoords\((lane|r|t)\.points\);\s*setDraftSource\(null\)/g)).toHaveLength(3);
    });

    it("the reason and the routed note stay on the chart until she taps them away (a 1.8 s flash didn't)", () => {
        expect(branch).toMatch(/if \(plot\.frame \|\| plot\.routed\)\s*setAutoRouteDiag\(/);
    });

    it("a Plan Your Day frame's ✕ says what it clears", () => {
        expect(code).toContain("'Clear the start and stop marks'");
    });

    it('says so on the chart when it cannot use the pins (the plotter is already open)', () => {
        const refusal = branch.slice(branch.indexOf('} else {'));
        expect(refusal).toContain('flashTraceFeedback(');
        expect(refusal).toContain("Plan Your Day's pins didn't load");
    });

    it('never unparks the ⚡ buttons', () => {
        const helpers = readFileSync('components/map/mapHubHelpers.ts', 'utf8');
        expect(helpers).toMatch(/AUTO_ROUTE_BUTTON_VISIBLE\s*=\s*false/);
        expect(helpers).toMatch(/COURSE_FRAME_VISIBLE\s*=\s*false/);
    });
});
