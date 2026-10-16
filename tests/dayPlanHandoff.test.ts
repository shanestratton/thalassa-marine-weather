/**
 * Plan Your Day's handoff to the chart (build 124, slice 2; 127-PYD-3).
 *
 * Shane, 2026-10-10: "when you select somewhere, and plot on the chart. it
 * goes direct. straight over hills. rocks, other boats, land, sea, air, you
 * name it." Since 127-PYD-3 Plan Your Day never hands the chart a straight
 * line: "Use on the main chart" loads the ROUTED line into the Manual
 * plotter as an unsaved draft (out and back for a day trip, one way for an
 * overnight), the skipper's own saved route still plots as drawn, and with
 * neither, "Plot by hand" frames her start and the stop with two marks and
 * says why, with no pins and no line at all. Nothing is saved until the
 * skipper saves. The request is identity-fenced like every other tracer
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
import { AUTOROUTING_PROPOSAL_MAX_POINTS } from '../services/autoroutingProposalEvidence';
import { AUTOROUTING_TRIAL_MAX_POINTS } from '../types/autorouting';

const START = { lat: -20.265, lon: 148.719, name: 'Fixture Marina' };
const AT = { lat: START.lat, lon: START.lon };
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
    points: [AT, { lat: -20.28, lon: 148.8 }, { lat: -20.26, lon: 148.9 }, CID],
    lengthNm: 14.8,
};
/** A routed line round a fictional headland (127-PYD-2's proposal coordinates as she reads them). */
const ROUTED = [AT, { lat: -20.31, lon: 148.83 }, { lat: -20.29, lon: 148.91 }, CID];
const NO_CHART = 'No chart for Cid Harbour on this phone: add charts for this area to route round the land.';

describe('plotDayAction: what Plan Your Day hands the chart (127-PYD-3)', () => {
    it('a stop with no routed line and no saved route is never a straight line: two marks, the reason, no pins', () => {
        const action = plotDayAction(START, candidate(), '2h', null, NO_CHART);
        expect(action).toEqual({
            kind: 'plot-day',
            points: [],
            name: 'Day out: Cid Harbour',
            stop: 'Cid Harbour',
            frame: { from: START, to: { ...CID, name: 'Cid Harbour' }, why: NO_CHART },
        });
        // A tester: no routing words at all.
        expect(plotDayAction(START, candidate(), 'overnight').frame?.why).toBe('');
        expect(plotDayAction(START, candidate(), 'overnight').name).toBe('Overnight: Cid Harbour');
        for (const stay of ['1h', '2h', '4h', 'overnight'] as const)
            expect(plotDayAction(START, candidate(), stay).points).toEqual([]);
    });

    it('with a routed line: out and back for a day trip, one way overnight, marked routed, no saved name', () => {
        const day = plotDayAction(START, candidate(), '4h', ROUTED);
        expect(day).toEqual({
            kind: 'plot-day',
            points: [...ROUTED, ...[...ROUTED].reverse().slice(1)],
            name: 'Day out: Cid Harbour',
            stop: 'Cid Harbour',
            routed: true,
        });
        // The stop is not dropped twice.
        expect(day.points.filter((p) => p.lat === CID.lat && p.lon === CID.lon)).toHaveLength(1);
        const night = plotDayAction(START, candidate(), 'overnight', ROUTED);
        expect(night.points).toEqual(ROUTED);
        expect(night).toMatchObject({ routed: true, name: 'Overnight: Cid Harbour' });
        expect(night.savedRoute).toBeUndefined();
        expect(night.frame).toBeUndefined();
    });

    it("a routed line whose satellite land check didn't run carries why, as a caution, not a gate", () => {
        const slow = "the satellite relief service didn't answer within 12 s";
        expect(plotDayAction(START, candidate(), '4h', ROUTED, '', slow)).toMatchObject({
            routed: true,
            unchecked: slow,
            points: [...ROUTED, ...[...ROUTED].reverse().slice(1)],
        });
        // No reason kept: still said, with no reason.
        expect(plotDayAction(START, candidate(), 'overnight', ROUTED, '', '').unchecked).toBe('');
        // Checked, or no routed line at all: nothing to caution.
        expect(plotDayAction(START, candidate(), '4h', ROUTED)).not.toHaveProperty('unchecked');
        expect(plotDayAction(START, candidate(), '4h', null, NO_CHART, slow)).not.toHaveProperty('unchecked');
    });

    it('a routed line wins over a saved route, and is copied: the plan cannot be edited through the chart', () => {
        const c = candidate({ distance: distanceEstimate(START, CID, null, SAVED) });
        const action = plotDayAction(START, c, 'overnight', ROUTED);
        expect(action.points).toEqual(ROUTED);
        expect(action.savedRoute).toBeUndefined();
        action.points[1].lat = 0;
        expect(ROUTED[1].lat).toBe(-20.31);
    });

    it('the longest line the router may return goes there and back within what the chart takes', () => {
        expect(2 * AUTOROUTING_TRIAL_MAX_POINTS - 1).toBeLessThanOrEqual(PLOT_DAY_MAX_POINTS);
        const longest = Array.from({ length: AUTOROUTING_TRIAL_MAX_POINTS }, (_, i) => ({
            lat: START.lat + ((CID.lat - START.lat) * i) / (AUTOROUTING_TRIAL_MAX_POINTS - 1),
            lon: START.lon + ((CID.lon - START.lon) * i) / (AUTOROUTING_TRIAL_MAX_POINTS - 1),
        }));
        const day = plotDayAction(START, candidate(), '2h', longest);
        expect(day.points).toHaveLength(PLOT_DAY_MAX_POINTS);
        expect(plotDayPins(day)?.points).toHaveLength(PLOT_DAY_MAX_POINTS);
        // Longer still (never from the router): one way, home by Reverse route; still never straight pins.
        const over = [...longest, CID];
        const oneWay = plotDayAction(START, candidate(), '2h', over);
        expect(oneWay.points).toHaveLength(over.length);
        expect(oneWay).toMatchObject({ routed: true, stop: 'Cid Harbour (home: Reverse route)' });
    });

    it('a saved route that joins them is used as drawn, and turned round for the trip home (unchanged)', () => {
        const c = candidate({ distance: distanceEstimate(START, CID, null, SAVED) });
        const day = plotDayAction(START, c, '4h');
        expect(day.savedRoute).toBe('Airlie → Cid');
        expect(day.points).toEqual([...SAVED.points, ...[...SAVED.points].reverse().slice(1)]);
        expect(day.points.filter((p) => p.lat === CID.lat && p.lon === CID.lon)).toHaveLength(1);
        expect(day.routed).toBeUndefined();
        const night = plotDayAction(START, c, 'overnight');
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
        const day = plotDayAction(START, candidate({ distance: distanceEstimate(START, CID, null, route) }), '2h');
        expect(day.points).toHaveLength(599);
        expect(day.savedRoute).toBe('Auto: Airlie → Cid');
        expect(plotDayPins(day)?.points).toHaveLength(599);
        // As long as any saved route may be (saved_routes holds 10,000 points), there and back.
        expect(PLOT_DAY_MAX_POINTS).toBe(2 * AUTOROUTING_PROPOSAL_MAX_POINTS - 1);
    });

    it('a saved route too long to take there and back gives the two marks and says where to open it: never straight pins', () => {
        const route: SavedRouteMatch = {
            name: 'Far too long',
            points: Array.from({ length: PLOT_DAY_MAX_POINTS }, (_, i) => ({
                lat: START.lat + ((CID.lat - START.lat) * i) / (PLOT_DAY_MAX_POINTS - 1),
                lon: START.lon + ((CID.lon - START.lon) * i) / (PLOT_DAY_MAX_POINTS - 1),
            })),
            lengthNm: 14.8,
        };
        const day = plotDayAction(START, candidate({ distance: distanceEstimate(START, CID, null, route) }), '2h');
        expect(day.points).toEqual([]);
        expect(day.savedRoute).toBeUndefined();
        expect(day.frame?.why).toBe('Your saved route is too long to plot here: open it from Saved Routes.');
        expect(plotDayPins(day)).not.toBeNull();
    });

    it('frames a place anywhere in the world the same way (Nouméa and Horta: no atlas)', () => {
        const noumea = { lat: -22.2758, lon: 166.458, name: 'Fixture Nouméa' };
        const baie = { lat: -22.3201, lon: 166.4398 };
        const action = plotDayAction(
            noumea,
            candidate({
                id: 'osm-node99',
                name: 'Fixture Baie',
                source: 'osm',
                ...baie,
                distance: distanceEstimate(noumea, baie, null),
            }),
            '1h',
        );
        expect(action.points).toEqual([]);
        expect(action.frame).toEqual({ from: noumea, to: { ...baie, name: 'Fixture Baie' }, why: '' });
        expect(action.name).toBe('Day out: Fixture Baie');
        const horta = { lat: 38.5306, lon: -28.6247, name: 'Fixture Horta' };
        const lajes = { lat: 38.3926, lon: -28.2558 };
        const routed = [{ lat: horta.lat, lon: horta.lon }, { lat: 38.47, lon: -28.43 }, lajes];
        const night = plotDayAction(
            horta,
            candidate({ name: 'Fixture Lajes', ...lajes, distance: distanceEstimate(horta, lajes, null) }),
            'overnight',
            routed,
        );
        expect(night).toMatchObject({ points: routed, routed: true, name: 'Overnight: Fixture Lajes' });
    });
});

describe('plotDayPins: what the chart accepts from a plot-day request', () => {
    const valid = plotDayAction(START, candidate(), '2h', ROUTED);
    const frame = plotDayAction(START, candidate(), '2h', null, NO_CHART);

    it('passes a routed request through, marked routed', () => {
        expect(plotDayPins(valid)).toEqual({
            points: [...ROUTED, ...[...ROUTED].reverse().slice(1)],
            name: 'Day out: Cid Harbour',
            stop: 'Cid Harbour',
            savedRoute: null,
            routed: true,
            frame: null,
            unchecked: null,
        });
        // An unchecked satellite land check goes with it; a frame or a saved route has none to carry.
        const slow = "the satellite relief service didn't answer within 12 s";
        expect(plotDayPins({ ...valid, unchecked: ` ${slow} ` })?.unchecked).toBe(slow);
        expect(plotDayPins({ ...valid, unchecked: '' })?.unchecked).toBe('');
        expect(plotDayPins({ ...frame, unchecked: slow })?.unchecked).toBeNull();
    });

    it('accepts no pins with a frame: both marks and the reason', () => {
        expect(plotDayPins(frame)).toEqual({
            points: [],
            name: 'Day out: Cid Harbour',
            stop: 'Cid Harbour',
            savedRoute: null,
            routed: false,
            frame: { from: START, to: { ...CID, name: 'Cid Harbour' }, why: NO_CHART },
            unchecked: null,
        });
    });

    it('refuses a frame with a bad position, or with pins', () => {
        const f = frame.frame!;
        expect(plotDayPins({ ...frame, frame: { ...f, to: { ...f.to, lat: 91 } } })).toBeNull();
        expect(plotDayPins({ ...frame, frame: { ...f, from: { ...f.from, lon: Number.NaN } } })).toBeNull();
        expect(plotDayPins({ ...frame, frame: { ...f, from: null as never } })).toBeNull();
        expect(plotDayPins({ ...frame, points: [AT, CID] })).toBeNull();
        // Nameless marks are named plainly rather than refused.
        expect(plotDayPins({ ...frame, frame: { ...f, from: { ...f.from, name: ' ' } } })?.frame?.from.name).toBe(
            'Start',
        );
    });

    it('refuses fewer than two pins, a bad coordinate, or a runaway list', () => {
        expect(plotDayPins({ ...valid, points: [] })).toBeNull();
        expect(plotDayPins({ ...valid, points: [AT] })).toBeNull();
        expect(plotDayPins({ ...valid, points: [AT, { lat: Number.NaN, lon: 1 }] })).toBeNull();
        expect(plotDayPins({ ...valid, points: [AT, { lat: 91, lon: 1 }] })).toBeNull();
        expect(plotDayPins({ ...valid, points: [AT, { lat: 1, lon: 181 }] })).toBeNull();
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

    const action: TracerOpenAction = plotDayAction(START, candidate(), '2h', ROUTED);

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

    it('loads the line as a fresh, unsaved draft and fits it on the chart', () => {
        expect(branch).toContain('plotDayPins(action)');
        expect(branch).toContain('setLegAnchor(null)');
        expect(branch).toContain('clearReturnContext()');
        expect(branch).toContain('rebaseHistoryRef.current = true');
        expect(branch).toContain('setCapturedCoords(plot.points)');
        expect(branch).toContain('setTraceName(plot.name)');
        expect(branch).toContain('setSavedTraces(loadSavedTraces())');
        expect(branch).toContain('fitTraceBounds(mapRef.current,');
        expect(branch).toContain('tracerHandoffTimersRef.current.add(timer)');
        expect(branch).toContain('1_200');
        expect(branch).toContain('isAuthIdentityScopeCurrent(requestScope)');
        // Nothing is saved until the skipper saves.
        expect(branch).not.toMatch(/\bsaveTrace\(|commitTraceSave\(|decideTraceSave\(/);
    });

    it('a routed line says where it came from, and what checks it, follows it and keeps it', () => {
        expect(branch).toContain("setDraftSource(plot.routed ? 'day-plan-route' : null)");
        expect(branch).toContain(
            "`Plan Your Day's route to ${plot.stop}: Route report is checking it; Sail follows it, Save keeps it.${",
        );
        expect(branch).toContain('`Your saved route to ${plot.stop}: Route report checks it against your charts`');
    });

    it("a routed line whose satellite land check didn't run says so on the chart: the Route report checks charts only", () => {
        expect(branch).toContain('plot.unchecked === null');
        expect(branch).toContain(
            '` Satellite land check not done${plot.unchecked && ` (${plot.unchecked})`}: Route report checks your charts only.`',
        );
    });

    it('what it says stays long enough to read: about 60 ms a character, never under the usual 1.8 s', () => {
        expect(code).toContain('const flashTraceFeedback = useCallback((msg: string, ms = 1800) => {');
        expect(code).toMatch(/feedbackTimerRef\.current = setTimeout\(\(\) => \{[^}]*\}, ms\);/);
        expect(branch).toContain('flashTraceFeedback(said, Math.max(1800, said.length * 60))');
    });

    it("every other load that replaces her pins ends the draft's Plan Your Day mark (127-C-b reads it)", () => {
        const before = (at: number) => code.slice(Math.max(0, at - 400), at);
        // Paste, a proven lane, the pending queue and the card library replace the pins without
        // setLegAnchor/clearReturnContext (which end the mark themselves).
        const paste = code.indexOf('const pasteTrace = useCallback');
        const loads = [
            code.indexOf('setCapturedCoords(pins)', paste),
            code.indexOf('setCapturedCoords(lane.points)'),
            code.indexOf('setCapturedCoords(r.points)'),
            code.lastIndexOf('setCapturedCoords(t.points)'),
        ];
        for (const at of loads) {
            expect(at).toBeGreaterThan(-1);
            expect(before(at)).toContain('setDraftSource(null)');
        }
    });

    it('a frame sets the two marks as a Plan Your Day frame, flies to both and says why: no straight line', () => {
        expect(branch).toContain('setTraceOrigin(plot.frame?.from ?? null)');
        expect(branch).toContain('setTraceDest(plot.frame?.to ?? null)');
        expect(branch).toContain("setTraceFrameKind(plot.frame ? 'day-plan' : null)");
        expect(branch).toContain('[plot.frame.from, plot.frame.to]');
        expect(branch).toContain('`${plot.frame.why} Drop pins round the land; Route report checks them.`');
        // The straight-pin toast is gone (127-PYD-3).
        expect(code).not.toContain('Straight lines to');
        expect(code).not.toContain('drag pins round the land');
    });

    it("the course frame's From/To boxes mark their frame 'course'; only it draws the bearing hint", () => {
        const course = code.slice(
            code.indexOf('const setCourseFrame = useCallback'),
            code.indexOf('const clearCourseFrame'),
        );
        expect(course).toContain("setTraceFrameKind('course')");
        expect(code).toContain("destHint: traceFrameKind === 'course'");
    });

    it('says so on the chart when it cannot use the pins (the plotter is already open)', () => {
        const refusal = branch.slice(branch.indexOf('} else {'));
        expect(refusal).toContain('flashTraceFeedback(');
        expect(refusal).toContain("Plan Your Day's pins didn't load");
    });

    it('retains the course-frame gate while independently checked per-leg Auto is visible', () => {
        const helpers = readFileSync('components/map/mapHubHelpers.ts', 'utf8');
        expect(helpers).toMatch(/AUTO_ROUTE_BUTTON_VISIBLE\s*=\s*true/);
        expect(helpers).toMatch(/COURSE_FRAME_VISIBLE\s*=\s*false/);
    });
});
