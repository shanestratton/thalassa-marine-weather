/**
 * Plan Your Day's handoff to the chart (build 124, slice 2).
 *
 * Both ⚡ buttons in the chart's route plotter are parked
 * (mapHubHelpers.ts AUTO_ROUTE_BUTTON_VISIBLE / COURSE_FRAME_VISIBLE), so
 * "Plot on chart" loads straight pins into the MANUAL plotter: start → stop
 * (→ start for a day trip), or the skipper's own saved route when one joins
 * the two. The skipper drags the pins round the land; nothing is saved until
 * the skipper saves. The request is identity-fenced like every other tracer
 * handoff: it carries the boat's position.
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

describe('plotDayAction: the pins Plot on chart drops', () => {
    it('a day trip is straight out and straight home: start, stop, start', () => {
        const action = plotDayAction(START, candidate(), '2h');
        expect(action).toEqual({
            kind: 'plot-day',
            points: [START, CID, START],
            name: 'Day out: Cid Harbour',
            stop: 'Cid Harbour',
        });
    });

    it('an overnight stay is one way: start, stop', () => {
        const action = plotDayAction(START, candidate(), 'overnight');
        expect(action.points).toEqual([START, CID]);
        expect(action.name).toBe('Overnight: Cid Harbour');
    });

    it('a saved route that joins them is used as drawn, and turned round for the trip home', () => {
        const c = candidate({ distance: distanceEstimate(START, CID, null, SAVED) });
        const day = plotDayAction(START, c, '4h');
        expect(day.savedRoute).toBe('Airlie → Cid');
        expect(day.points).toEqual([...SAVED.points, ...[...SAVED.points].reverse().slice(1)]);
        // The stop is not dropped twice.
        expect(day.points.filter((p) => p.lat === CID.lat && p.lon === CID.lon)).toHaveLength(1);
        const night = plotDayAction(START, c, 'overnight');
        expect(night.points).toEqual(SAVED.points);
    });

    it('copies the points, so the plan cannot be edited through the chart', () => {
        const c = candidate({ distance: distanceEstimate(START, CID, null, SAVED) });
        const action = plotDayAction(START, c, 'overnight');
        action.points[0].lat = 0;
        expect(SAVED.points[0].lat).toBe(START.lat);
    });

    it('plots a place anywhere in the world the same way (Nouméa, no atlas)', () => {
        const noumea = { lat: -22.2758, lon: 166.458 };
        const baie = { lat: -22.3201, lon: 166.4398 };
        const action = plotDayAction(
            noumea,
            candidate({
                id: 'osm-node99',
                name: 'Baie de Maa',
                source: 'osm',
                ...baie,
                distance: distanceEstimate(noumea, baie, null),
            }),
            '1h',
        );
        expect(action.points).toEqual([noumea, baie, noumea]);
        expect(action.name).toBe('Day out: Baie de Maa');
    });
});

describe('plotDayPins: what the chart accepts from a plot-day request', () => {
    const valid = plotDayAction(START, candidate(), '2h');

    it('passes a good request through', () => {
        expect(plotDayPins(valid)).toEqual({
            points: [START, CID, START],
            name: 'Day out: Cid Harbour',
            stop: 'Cid Harbour',
            savedRoute: null,
        });
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

    const action: TracerOpenAction = plotDayAction(START, candidate(), '2h');

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
        expect(branch).toContain('fitTraceBounds(mapRef.current, plot.points)');
        expect(branch).toContain('tracerHandoffTimersRef.current.add(timer)');
        expect(branch).toContain('1_200');
        expect(branch).toContain('isAuthIdentityScopeCurrent(requestScope)');
        // Nothing is saved until the skipper saves.
        expect(branch).not.toMatch(/\bsaveTrace\(|commitTraceSave\(|decideTraceSave\(/);
    });

    it('tells the skipper what the straight lines are, and what checks them', () => {
        expect(branch).toContain(
            '`Straight lines to ${plot.stop}: drag pins round the land, then Route report checks your charts`',
        );
        expect(branch).toContain('`Your saved route to ${plot.stop}: Route report checks it against your charts`');
    });

    it('never unparks the ⚡ buttons', () => {
        const helpers = readFileSync('components/map/mapHubHelpers.ts', 'utf8');
        expect(helpers).toMatch(/AUTO_ROUTE_BUTTON_VISIBLE\s*=\s*false/);
        expect(helpers).toMatch(/COURSE_FRAME_VISIBLE\s*=\s*false/);
    });
});
